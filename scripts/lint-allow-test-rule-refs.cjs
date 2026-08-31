#!/usr/bin/env node
'use strict';

/**
 * lint-allow-test-rule-refs.cjs — enforce that NEW `allow-test-rule:` exemption
 * comments carry a tracking-issue reference, AND that the number of exemptions
 * that ACTUALLY suppress a detected violation only ever ratchets down.
 *
 * ## Why
 *
 * `allow-test-rule:` is an inline comment that disables the `no-source-grep`
 * ESLint rule at a specific site.  Per ADR-456
 * (docs/adr/456-test-rigor-architecture.md) every NEW exemption must carry a
 * `#NNN` issue reference or an https:// URL so the decision is traceable.
 *
 * ## What "compliant" means (citation check)
 *
 * A compliant `allow-test-rule:` comment is one whose reason text (everything
 * after the colon) contains either:
 *   - a `#\d+` token  (e.g. `// allow-test-rule: see #1234`)
 *   - an https?:// URL
 *
 * Any other comment is an OFFENDER.
 *
 * ## Grandfathering (citation check)
 *
 * All pre-existing untracked exemptions are recorded in
 * scripts/lint-allow-test-rule-refs.allowlist.json (seeded at gate introduction
 * time).  The identity ratchet (scripts/lib/allowlist-ratchet.cjs) means:
 *   - A NEW non-compliant comment not in the allowlist → gate fails.
 *   - A previously-offending comment that is now compliant → allowlist entry is
 *     STALE and must be pruned (ratchet-down; the baseline only ever shrinks).
 *
 * ## Offender identifiers (citation check)
 *
 * Identifiers are stable cross-rename-safe strings of the form:
 *   `<repo-relative-path> :: <trimmed-reason>`
 *
 * e.g. `tests/foo.test.cjs :: source-text-is-the-product`
 *
 * If a file has multiple non-compliant comments with the SAME reason text, only
 * one identifier is recorded (deduped via Set).
 *
 * ## Effective exemptions vs. unverified markers (#3520 / epic #3464 phase 5)
 *
 * A marker-bearing FILE is not the same thing as a marker that suppresses
 * anything.  Historically this gate counted "distinct files containing marker
 * text" (294 at one baseline), but only a handful of those markers actually
 * sit next to a violation the `no-source-grep` rule can detect — the rest are
 * "counted" only because they contain the literal substring, which made the
 * old ceiling ~98% noise and free to bump.
 *
 * This gate now reports and ratchets TWO separate numbers instead:
 *
 *   1. **Effective exemption SITES** — a site (one flagged read+search pair)
 *      where a marker is adjacent enough (per the rule's own
 *      `isSuppressedAt` site-scoped adjacency predicate) to suppress a
 *      violation the rule actually detects there. Tightly ratcheted via
 *      `assertTightCeiling` (both directions — growth past ceiling fails,
 *      and slack beyond `grace` fails, forcing the ceiling to track the
 *      real high-water mark).
 *
 *   2. **Unverified marker-bearing FILES** — files that carry an
 *      `allow-test-rule:` marker but for which no detectable violation was
 *      found adjacent to any marker in the file (rule-coverage gap, not
 *      necessarily a vestigial marker — see "Known limits" below). Reported
 *      with its own ceiling so it cannot silently balloon, but NOT tightly
 *      ratcheted: dropping below the ceiling never fails the gate, because
 *      shrinking this pool means widening rule coverage file-by-file with
 *      evidence, not deleting markers on the strength of this metric alone.
 *
 * A file with >=1 effective site counts ONLY as effective, never also as
 * unverified (test-matrix.md #3520 row 5) — no double counting.
 *
 * ## Scan scope: every glob that registers the rule, not just `tests/*.test.cjs`
 *
 * `local/no-source-grep` is registered by `eslint.config.mjs` on several
 * glob blocks, not only `tests/** /*.cjs`: also `scripts/** /*.cjs`,
 * `eslint-rules/** /*.cjs`, `bin/lib/** /*.cjs`, `pi/** /*.cjs`,
 * `examples/** /*.cjs`, `gsd-core/bin/** /*.cjs`, `vscode/*.js`,
 * `.kilo/plugins/*.js`, and `.opencode/plugins/*.js`. A prior version of
 * this script only walked `tests/** /*.test.cjs`, which silently dropped
 * every non-`.test.cjs` file under `tests/` AND every file under every one
 * of those other blocks from BOTH reported numbers — a marker there would
 * vanish rather than trip a ceiling. `deriveNoSourceGrepGlobs` (below) reads
 * the authoritative glob list directly out of `eslint.config.mjs` at run
 * time (dynamic `import()`, since this is a `.cjs` script and the config is
 * ESM) so the scan set cannot drift from what ESLint itself actually lints.
 *
 * ## Single source of truth for detection
 *
 * This script does NOT reimplement the `no-source-grep` rule's AST walk or
 * its site-scoped adjacency predicate — doing so would be the
 * generative-fix-divergence defect class this repo has shipped before.
 * Instead it drives the REAL rule through ESLint's `Linter` API with its
 * `neutralizeSuppression` diagnostic option (see the rule's `meta.schema`
 * doc comment) to enumerate every candidate violation SITE in a file
 * regardless of markers, then classifies each site by calling the rule's own
 * exported `isSuppressedAt` predicate against that file's real markers (also
 * obtained via the rule's exported `collectMarkerAndCommentLines`) — the
 * exact function the rule itself calls at report time. See
 * `eslint-rules/no-source-grep.cjs`.
 *
 * ## Known limits (do not read "effective" as "all exemptions")
 *
 * The effective-sites count is only as good as `no-source-grep`'s own
 * detection. Real source-text-search violations behind identifier
 * indirection (a path bound to a separate `const` the rule never resolves
 * back to its literal), dynamic paths, non-`.js`-family extensions (`.sh`),
 * and array/object round-trips are documented, accepted blind spots of the
 * rule (see its own "Known limits" in 40-design.md) and remain invisible to
 * BOTH numbers here. This is stated explicitly in this script's own `ok`
 * output so the effective count can never be read as "all exemptions are
 * accounted for."
 *
 * The two identifier-indirection sites this paragraph used to name --
 * tests/security-prompt-injection.security.test.cjs and
 * tests/check-update-config-dir.test.cjs -- were rewritten behaviorally in
 * #3523 and no longer read source at all, so there is currently no KNOWN
 * site sitting in the blind spot. That is emphatically not the same as the
 * blind spot being closed: the rule still cannot see a read behind a path
 * identifier, so a new one can be added tomorrow and neither number here
 * would move. Closing it is a separate, measured phase of epic #3464.
 *
 * ## Linter scope: marker-bearing files only (#3464 perf follow-up)
 *
 * The byte-based `walkGlobs` walk above still reads EVERY file in every
 * `local/no-source-grep`-registered glob (~1200 files) — that walk is cheap
 * (raw `fs.readFileSync`, no parsing) and stays repo-wide so no marker can
 * hide from the inventory. But driving the real ESLint `Linter` over all
 * ~1200 files to classify effective/live sites was the actual cost (~12s+
 * under CI load, enough to blow the test harness's spawn timeout). Only
 * files containing the literal `allow-test-rule:` substring can possibly
 * produce a genuine directive (`extractGenuineMarkerReasons` requires that
 * substring to be present) or an "effective"/"unverified" classification —
 * so `main` filters to marker-bearing files (a plain `String#includes` scan
 * over content already in memory from the walk, deliberately NOT a shell
 * `grep`: `tests/security-prompt-injection.security.test.cjs` contains a
 * literal NUL byte that a shell grep pipeline handles differently than
 * Node's own string/buffer handling does) BEFORE calling `classifySites`,
 * narrowing the Linter pass from ~1200 files to the ~294 that actually carry
 * a marker.
 *
 * This means the "live violations" figure this script reports now only
 * covers marker-bearing files. A live (unsuppressed) violation in a file
 * with NO marker at all is still caught — just not by this script: it is
 * exactly what `local/no-source-grep` itself flags when `npm run lint` /
 * `npm run lint:ci` runs across the same globs, and that run fails the build
 * independently. This script re-checking unmarked files for live violations
 * would be pure duplicate work with no distinct consequence (the marker
 * inventory and the citation/ratchet checks — the reason this script exists
 * — only ever concern marker-bearing files in the first place). If a live
 * violation IS found in a marker-bearing file, it still fails this gate
 * exactly as before this change.
 *
 * See docs/adr/456-test-rigor-architecture.md for the full policy.
 */

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { Linter } = require('eslint');
const { assertWithinAllowlist, assertTightCeiling } = require('./lib/allowlist-ratchet.cjs');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');
const noSourceGrepRule = require('../eslint-rules/no-source-grep.cjs');

const ROOT = path.join(__dirname, '..');
const ESLINT_CONFIG_PATH = path.join(ROOT, 'eslint.config.mjs');
const TESTS_DIR = process.env.GSD_LINT_ALLOW_TEST_RULE_TESTS_DIR || path.join(ROOT, 'tests');
// Overrides the ROOT that non-`tests/` glob base directories (scripts/,
// eslint-rules/, bin/lib/, pi/, examples/, gsd-core/bin/, vscode/,
// .kilo/plugins/, .opencode/plugins/ — see deriveNoSourceGrepGlobs) are
// resolved under. TESTS_DIR already has its own override (above) for the
// `tests/**/*.cjs` block; this is the equivalent knob for every OTHER block
// that registers `local/no-source-grep`, so sandbox fixtures can exercise
// the widened scan scope (#3464 phase 5 BLOCKER fix) without the test suite
// re-scanning this repo's real scripts/eslint-rules/etc. trees on every run.
const EXTRA_ROOT = process.env.GSD_LINT_ALLOW_TEST_RULE_EXTRA_ROOT || ROOT;
const ALLOWLIST_PATH =
  process.env.GSD_LINT_ALLOW_TEST_RULE_ALLOWLIST ||
  path.join(__dirname, 'lint-allow-test-rule-refs.allowlist.json');
const EFFECTIVE_CEILING_PATH =
  process.env.GSD_LINT_ALLOW_TEST_RULE_EFFECTIVE_CEILING ||
  path.join(__dirname, 'lint-allow-test-rule-refs.effective-ceiling.json');
const UNVERIFIED_CEILING_PATH =
  process.env.GSD_LINT_ALLOW_TEST_RULE_UNVERIFIED_CEILING ||
  path.join(__dirname, 'lint-allow-test-rule-refs.unverified-ceiling.json');

/** Matches a compliant issue reference or URL */
const ISSUE_REF_RE = /#\d+|https?:\/\//;

/**
 * Extract the "genuine directive" reason text(s) from a file's real AST
 * comments (never string/template literals, never source code — only actual
 * `//` or `/* * /` comment tokens, obtained the same way the rule itself does
 * via `sourceCode.getAllComments()`).
 *
 * A prior version of this scanned raw file TEXT line-by-line for the
 * substring `allow-test-rule:` anywhere on a line. That was safe while the
 * scan was confined to `tests/*.test.cjs` (real test files essentially never
 * discuss the marker syntax in prose), but widening the scan to
 * `scripts/** /*.cjs` and `eslint-rules/** /*.cjs` (#3464 phase 5 BLOCKER fix)
 * means it now also walks the RULE's own implementation and THIS script —
 * files that must document `// allow-test-rule: <reason> (#NNN)` as example
 * syntax in prose, JSDoc, and the rule's own message string. A raw
 * substring scan cannot tell "a real directive" apart from "a sentence that
 * mentions the directive" or "a string literal that quotes it" — so a
 * directly-widened raw scan produced dozens of false "uncited exemption"
 * failures on this repo's own documentation.
 *
 * Fixed here by requiring a match to be BOTH (a) inside a real comment token
 * (excludes string/template literals and code entirely — mirrors row 11's
 * "marker text inside a string literal is not a directive" contract) AND
 * (b) the FIRST non-whitespace content of that comment's line, once an
 * optional JSDoc continuation-line `*` prefix is stripped (excludes prose
 * that merely MENTIONS `allow-test-rule:` mid-sentence, e.g. "Matches a
 * `allow-test-rule: <reason>` directive..."). This is deliberately STRICTER
 * than the rule's own `MARKER_COMMENT_RE` (which matches the substring
 * anywhere in a comment's value, by design, so a marker's suppression reach
 * cannot be defeated by trailing prose on the same comment) — citation
 * tracking asks a narrower question ("is this meant as a real directive
 * that needs a tracking ref") than suppression does, so the two are allowed
 * to diverge.
 *
 * @param {{value: string, loc: {start: {line: number}}}[]} allComments
 * @returns {string[]}  raw reason text for every genuine directive line found
 */
function extractGenuineMarkerReasons(allComments) {
  const reasons = [];
  for (const comment of allComments) {
    for (const rawLine of comment.value.split('\n')) {
      const trimmed = rawLine.replace(/^\s*\*\s?/, '').trim();
      if (!/^allow-test-rule:/.test(trimmed)) continue;
      const reason = trimmed.slice('allow-test-rule:'.length).trim();
      if (reason) reasons.push(reason);
    }
  }
  return reasons;
}

/**
 * Derive the authoritative set of glob patterns that `eslint.config.mjs`
 * actually registers `local/no-source-grep` on (#3464 phase 5 BLOCKER fix).
 *
 * Historically this script hardcoded `tests/** /*.test.cjs` as "the" scan
 * set, which silently missed every non-`.test.cjs` file under `tests/`
 * (`tests/helpers/**`, `tests/qa/**`, `tests/fixtures/**`, ...) AND every one
 * of the other config blocks the rule is registered on (`scripts/** /*.cjs`,
 * `eslint-rules/** /*.cjs`, `bin/lib/** /*.cjs`, `pi/** /*.cjs`,
 * `examples/** /*.cjs`, `gsd-core/bin/** /*.cjs`, `vscode/*.js`,
 * `.kilo/plugins/*.js`, `.opencode/plugins/*.js`). A marker in any of those
 * would vanish from BOTH reported numbers instead of tripping anything.
 *
 * Rather than hand-maintain a second copy of that glob list (the exact
 * generative-fix-divergence class this script's own doc comment above
 * already warns about for the rule's AST walk), this dynamically imports
 * the REAL flat config and reads which config objects set
 * `rules['local/no-source-grep']` to something other than `'off'`/`0`,
 * collecting their `files` globs. If `eslint.config.mjs` ever adds, removes,
 * or narrows a block that registers this rule, this list moves with it
 * automatically — there is no second list to fall out of sync.
 *
 * @returns {Promise<string[]>} sorted, deduped glob patterns
 */
async function deriveNoSourceGrepGlobs() {
  const mod = await import(pathToFileURL(ESLINT_CONFIG_PATH).href);
  const config = mod.default;
  if (!Array.isArray(config)) {
    throw new Error(
      `lint-allow-test-rule-refs: expected eslint.config.mjs's default export to be an array, got ${typeof config}`
    );
  }

  const globs = new Set();
  for (const entry of config) {
    if (!entry || typeof entry !== 'object' || !entry.rules || !Array.isArray(entry.files)) continue;
    if (!Object.prototype.hasOwnProperty.call(entry.rules, 'local/no-source-grep')) continue;
    const ruleValue = entry.rules['local/no-source-grep'];
    const level = Array.isArray(ruleValue) ? ruleValue[0] : ruleValue;
    if (level === 'off' || level === 0) continue;
    for (const glob of entry.files) globs.add(glob);
  }

  if (globs.size === 0) {
    throw new Error(
      'lint-allow-test-rule-refs: derived zero glob patterns for local/no-source-grep from eslint.config.mjs ' +
        '— this would silently scan nothing; the config shape likely changed and this script needs updating.'
    );
  }

  return [...globs].sort();
}

/**
 * The literal (non-wildcard) leading path segments of a glob — the
 * directory that must actually be walked on disk to find candidate files.
 * e.g. `tests/** /*.cjs` -> `tests`, `.kilo/plugins/*.js` -> `.kilo/plugins`.
 *
 * The LAST segment is always excluded from consideration even when it has
 * no wildcard of its own (e.g. the single-file fixture globs
 * `tests/_ff_lint_violation.cjs` / `tests/_ff_lint_clean.cjs`, #1279/#2126):
 * it is the filename pattern to MATCH against directory entries, never a
 * directory to descend INTO. Treating a fully-literal glob's whole path as
 * a "directory" would try to `readdirSync` a plain file and silently find
 * nothing (caught by `walkGlobs`'s existing not-a-directory guard) — quietly
 * dropping that glob from the scan entirely, the same silent-omission defect
 * class this fix exists to eliminate.
 *
 * @param {string} glob
 * @returns {string}
 */
function globBaseDir(glob) {
  const segments = glob.split('/');
  const literalSegments = [];
  for (let i = 0; i < segments.length - 1; i++) {
    if (/[*?[\]{}]/.test(segments[i])) break;
    literalSegments.push(segments[i]);
  }
  return literalSegments.join('/');
}

/**
 * Compile a glob pattern (only `*` and `**` wildcards appear in this repo's
 * config — no `?`, `{}`, or `[]` are used on any `local/no-source-grep`
 * block) into an anchored RegExp matched against a POSIX-slash repo-relative
 * path, mirroring minimatch/eslint's own glob semantics for those two
 * operators: `** /` matches zero or more path segments, a bare `*` matches
 * within a single segment only.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++; // consume second '*'
      if (glob[i + 1] === '/') {
        re += '(?:.*/)?';
        i++; // consume the following '/'
      } else {
        re += '.*';
      }
    } else if (c === '*') {
      re += '[^/]*';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Recursively read every file matching ANY of `globs`, once, deduped by
 * absolute path.
 *
 * The citation check, the total marker-file inventory, and the
 * effective-site classification all need the same file set and content —
 * walking twice would be the generative-fix-divergence class of bug (two
 * scans that can silently drift apart), so every classifier below consumes
 * this single walk's output.
 *
 * Each glob's literal base directory (`globBaseDir`) is resolved to an
 * actual directory on disk: the `tests` base uses `testsDir` (the existing
 * `GSD_LINT_ALLOW_TEST_RULE_TESTS_DIR` override contract, unchanged), every
 * other base is resolved under `extraRoot` (defaults to `ROOT`, overridable
 * via `GSD_LINT_ALLOW_TEST_RULE_EXTRA_ROOT` so sandbox fixtures can exercise
 * the widened scan scope in isolation). Matching itself is always done
 * against the glob's own repo-relative path string (e.g. `tests/foo.cjs`,
 * `scripts/bar.cjs`), never against the physical scan location, so a
 * sandboxed base directory is matched exactly as if it WERE that
 * repo-relative path.
 *
 * @param {string[]} globs
 * @param {{testsDir: string, extraRoot: string, root: string}} opts
 * @returns {{relpath: string, full: string, content: string}[]}
 */
function walkGlobs(globs, { testsDir, extraRoot, root }) {
  const compiled = globs.map((glob) => ({
    baseDir: globBaseDir(glob),
    regex: globToRegExp(glob),
  }));
  const seen = new Map(); // full path -> {relpath, full, content}

  for (const { baseDir, regex } of compiled) {
    const scanRoot = baseDir === 'tests' ? testsDir : path.join(extraRoot, baseDir);

    const scan = (current, relParts) => {
      let entries;
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        // Base directory does not exist (e.g. an isolated sandbox EXTRA_ROOT
        // that only sets up the fixture-relevant subtree) — nothing to scan.
        return;
      }
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) {
          scan(full, [...relParts, entry.name]);
          continue;
        }
        if (!entry.isFile()) continue;
        const matchPath = [baseDir, ...relParts, entry.name].join('/');
        if (!regex.test(matchPath)) continue;
        if (seen.has(full)) continue;
        let content;
        try {
          content = fs.readFileSync(full, 'utf8');
        } catch {
          // skip unreadable files (e.g. binary)
          continue;
        }
        const relpath = path.relative(root, full).split(path.sep).join('/');
        seen.set(full, { relpath, full, content });
      }
    };

    scan(scanRoot, []);
  }

  return [...seen.values()];
}

/**
 * Collect offender identifiers (files with an UNCITED allow-test-rule marker)
 * from a per-file map of genuine directive reasons (see
 * `extractGenuineMarkerReasons`).
 *
 * @param {Map<string, string[]>} markerReasonsByFile  relpath -> reasons
 * @returns {string[]}  sorted, deduped list of `<relpath> :: <reason>` strings
 */
function collectUncitedOffenders(markerReasonsByFile) {
  const offenders = new Set();

  for (const [relpath, reasons] of markerReasonsByFile) {
    for (const reason of reasons) {
      if (ISSUE_REF_RE.test(reason)) continue; // compliant — skip
      offenders.add(`${relpath} :: ${reason}`);
    }
  }

  return [...offenders].sort();
}

/**
 * Files carrying at least one genuine allow-test-rule directive, cited or
 * not — the universe that effective/unverified partitions.
 *
 * @param {Map<string, string[]>} markerReasonsByFile  relpath -> reasons
 * @returns {string[]}  sorted, deduped list of relpaths
 */
function collectExemptionFiles(markerReasonsByFile) {
  const marked = [];
  for (const [relpath, reasons] of markerReasonsByFile) {
    if (reasons.length > 0) marked.push(relpath);
  }
  return marked.sort();
}

/**
 * ESLint eslintrc-format config fragment that runs ONLY `no-source-grep`,
 * with suppression neutralized so every candidate site is reported
 * regardless of a marker being present. Shared by every file classified
 * below.
 *
 * Deliberately eslintrc-shaped (`parserOptions`/`env`), not flat-config
 * (`languageOptions`/`plugins`+`files`) (#3464 phase 5 follow-up). Flat
 * config's `Linter#verify` still validates that the filename resolves to an
 * ancestor of the Linter's `cwd` even for a config with no `files` glob
 * (i.e. one meant to apply universally) — any filename that only resolves
 * via a leading `..` (exactly what `walkGlobs`' `path.relative(ROOT, full)`
 * produces for a sandbox fixture outside ROOT, e.g. in CI's `/tmp`) trips
 * flat config's "No matching configuration found" error, indistinguishable
 * from this script's own defensive throw for a real misconfiguration
 * (`classifySiteLines`, `configProblem` below). eslintrc-format
 * `Linter#verify` performs no such cwd/ancestor check at all — the config
 * passed here fully determines what runs, `filename` is used only for
 * per-file diagnostics/overrides, never resolved against `cwd` — so
 * classification behaves identically for repo files and out-of-tree sandbox
 * fixtures. `sourceType`/`ecmaVersion`/node globals mirror the
 * `languageOptions` on every `eslint.config.mjs` block that registers
 * `local/no-source-grep` (see module doc comment above); verified to
 * produce byte-identical `Linter#verify` messages against flat config for
 * real repo files before this change shipped.
 */
const NEUTRALIZED_CONFIG = {
  parserOptions: { ecmaVersion: 2022, sourceType: 'commonjs' },
  env: { node: true },
  rules: { 'local/no-source-grep': ['error', { neutralizeSuppression: true }] },
};

/**
 * Build an eslintrc-format `Linter` with `local/no-source-grep` registered
 * directly via `defineRule` (no plugin-name resolution, no flat-config
 * `files` matching) — see `NEUTRALIZED_CONFIG` doc comment for why this
 * sidesteps the cwd/ancestor constraint entirely.
 *
 * @returns {import('eslint').Linter}
 */
function makeLinter() {
  const linter = new Linter({ configType: 'eslintrc' });
  linter.defineRule('local/no-source-grep', noSourceGrepRule);
  return linter;
}

/**
 * For one file, drive the REAL `no-source-grep` rule via ESLint's `Linter`
 * API (suppression neutralized) to enumerate every candidate violation site,
 * then classify each site with the rule's own exported `isSuppressedAt`
 * predicate against that file's real markers (obtained via the rule's own
 * exported `collectMarkerAndCommentLines`, fed by the SAME parse the
 * enumeration pass just produced via `linter.getSourceCode()`).
 *
 * This does not hand-roll a second AST walk or a second adjacency
 * arithmetic: both the enumeration (the rule's Program:exit walk) and the
 * classification (`isSuppressedAt`) are the rule's own code, imported and
 * invoked directly. Returns per-site LINE NUMBERS (not just counts) so a
 * consumer (notably the parity test in
 * tests/lint-allow-test-rule-refs.test.cjs) can compare this classification
 * site-by-site against the real rule's independent report/no-report outcome.
 *
 * Also returns `markerReasons` (see `extractGenuineMarkerReasons`) computed
 * from the SAME parse, so the citation check and exemption-file inventory
 * (`main`, via `classifySites`) never re-parse a file a second time just to
 * find its markers.
 *
 * @param {import('eslint').Linter} linter
 * @param {{relpath: string, content: string}} file
 * @returns {{effectiveLines: number[], liveLines: number[], markerReasons: string[]}}
 */
function classifySiteLines(linter, file) {
  let messages;
  try {
    messages = linter.verify(file.content, NEUTRALIZED_CONFIG, file.relpath);
  } catch (err) {
    // An unparseable file must NOT be silently classified as "zero sites"
    // (indistinguishable from a genuinely clean file) — that is exactly the
    // false-clean failure mode this counter exists to eliminate, and it
    // would be inconsistent with the sibling "No matching configuration
    // found" case just below, which correctly throws. Fail loudly with the
    // file path and the underlying error instead. If a specific file
    // genuinely cannot be parsed for a known, accepted reason, exempt it
    // explicitly by name with a comment here — never blanket-swallow.
    throw new Error(
      `lint-allow-test-rule-refs: failed to parse/verify ${file.relpath}: ` +
        `${err && err.message ? err.message : err}`
    );
  }

  // A parse error does NOT throw a JS exception from linter.verify() -- ESLint
  // catches it internally and reports it as a `fatal: true` message instead,
  // with `sourceCode` left unset (getSourceCode() below would return null).
  // This is the same silent-clean failure mode the catch block above guards
  // against, just reached via a different ESLint API shape: without this
  // check a genuinely unparseable file would either crash on the next line
  // (`sourceCode.getAllComments()` on null) or, before that line existed,
  // silently fall through the `sites.length === 0` early return below and be
  // reported as zero violations -- indistinguishable from a clean file. Fail
  // loudly with the file path and message instead, matching the sibling
  // "No matching configuration found" case just below.
  const fatalProblem = messages.find((m) => m.fatal);
  if (fatalProblem) {
    throw new Error(
      `lint-allow-test-rule-refs: failed to parse/verify ${file.relpath}: ` +
        `${fatalProblem.message} (line ${fatalProblem.line}, column ${fatalProblem.column})`
    );
  }

  // Defensive: "No matching configuration found for ..." was ESLint's
  // flat-config-specific signal that it could not match ANY configuration to
  // a filename (notably, when the Linter's cwd was not an ancestor of the
  // file -- exactly what an out-of-tree sandbox fixture path hit, #3464
  // phase 5 follow-up). `makeLinter`/`NEUTRALIZED_CONFIG` now use
  // eslintrc-format `Linter#verify`, which performs no cwd/ancestor
  // resolution at all, so this specific message should never fire in
  // practice. Kept as a defensive throw (rather than deleted) in case a
  // future ESLint version emits an equivalent `ruleId === null` signal for
  // eslintrc-format verification too -- silently reporting zero rule
  // messages would be indistinguishable from a genuinely clean file, exactly
  // the kind of silently-wrong number this counter exists to avoid.
  const configProblem = messages.find(
    (m) => m.ruleId === null && /No matching configuration found/.test(m.message)
  );
  if (configProblem) {
    throw new Error(
      `lint-allow-test-rule-refs: ESLint could not lint ${file.relpath} (${configProblem.message}).`
    );
  }

  const sourceCode = linter.getSourceCode();
  const allComments = sourceCode.getAllComments();
  const markerReasons = extractGenuineMarkerReasons(allComments);

  const sites = messages.filter((m) => m.messageId === 'noSourceGrep');
  if (sites.length === 0) return { effectiveLines: [], liveLines: [], markerReasons };

  // The rule's own suppression check (isSuppressed, called from
  // reportUnlessSuppressed) is an OR over TWO lines: the search call's own
  // line, and the line of the readFileSync() call that originated the
  // tracked value (a marker adjacent to EITHER half suppresses). In
  // neutralizeSuppression mode the rule emits a paired
  // `noSourceGrepDiagnosticReadLine` message at the SAME node carrying that
  // read line, so this classification can replicate the identical two-line
  // OR check the rule performs internally -- via the rule's OWN
  // `isSuppressedAt` predicate, called exactly as `reportUnlessSuppressed`
  // does, rather than only checking the search line (which would
  // misclassify the documented "marker adjacent to the read, not the
  // search" placement style as unsuppressed).
  const readLineByPos = new Map();
  for (const m of messages) {
    if (m.messageId !== 'noSourceGrepDiagnosticReadLine') continue;
    readLineByPos.set(`${m.line}:${m.column}`, m.message === '' ? null : Number(m.message));
  }

  const { markerLines, commentLineSet } = noSourceGrepRule.collectMarkerAndCommentLines(allComments);

  const effectiveLines = [];
  const liveLines = [];
  for (const site of sites) {
    const readLine = readLineByPos.get(`${site.line}:${site.column}`) ?? null;
    const suppressedBySearchLine = noSourceGrepRule.isSuppressedAt({
      markerLines,
      violationLine: site.line,
      commentLineSet,
      lines: sourceCode.lines,
    });
    const suppressedByReadLine =
      readLine !== null &&
      noSourceGrepRule.isSuppressedAt({
        markerLines,
        violationLine: readLine,
        commentLineSet,
        lines: sourceCode.lines,
      });
    if (suppressedBySearchLine || suppressedByReadLine) effectiveLines.push(site.line);
    else liveLines.push(site.line);
  }

  return { effectiveLines, liveLines, markerReasons };
}

/**
 * Count-only view of classifySiteLines, used by the aggregate walk below.
 *
 * @param {import('eslint').Linter} linter
 * @param {{relpath: string, content: string}} file
 * @returns {{effectiveSites: number, liveSites: number, markerReasons: string[]}}
 */
function classifyFile(linter, file) {
  const { effectiveLines, liveLines, markerReasons } = classifySiteLines(linter, file);
  return { effectiveSites: effectiveLines.length, liveSites: liveLines.length, markerReasons };
}

/**
 * Convenience wrapper for tests: classify a single in-memory code string
 * without a caller having to construct a Linter instance or a file object.
 *
 * @param {string} code
 * @param {string} [relpath] - filename passed to ESLint (affects nothing but
 *   diagnostics; the eslintrc-format `Linter` built by `makeLinter` never
 *   resolves it against a base path, so this may be any string, in-tree or
 *   not). Defaults to a generic test filename.
 * @returns {{effectiveLines: number[], liveLines: number[]}}
 */
function classifyCode(code, relpath = 'tests/fixture.test.cjs') {
  return classifySiteLines(makeLinter(), { relpath, content: code });
}

/**
 * Classify every file's violation sites into effective (suppressed by a real
 * marker) vs. live (unsuppressed — should be zero in a clean tree), and
 * derive which files count as "effective" (>=1 effective site).
 *
 * @param {{relpath: string, content: string}[]} files
 * Also returns `markerReasonsByFile` (relpath -> genuine directive reasons,
 * see `extractGenuineMarkerReasons`), collected from the SAME per-file parse
 * this function already performs, so `main` can derive the citation check
 * and exemption-file inventory without a second file-content scan.
 *
 * @returns {{
 *   effectiveSiteCount: number,
 *   effectiveFiles: string[],
 *   liveSiteCount: number,
 *   liveFiles: string[],
 *   markerReasonsByFile: Map<string, string[]>,
 * }}
 */
function classifySites(files) {
  const linter = makeLinter();
  let effectiveSiteCount = 0;
  let liveSiteCount = 0;
  const effectiveFiles = new Set();
  const liveFiles = new Set();
  const markerReasonsByFile = new Map();

  for (const file of files) {
    const { effectiveSites, liveSites, markerReasons } = classifyFile(linter, file);
    if (effectiveSites > 0) {
      effectiveSiteCount += effectiveSites;
      effectiveFiles.add(file.relpath);
    }
    if (liveSites > 0) {
      liveSiteCount += liveSites;
      liveFiles.add(file.relpath);
    }
    if (markerReasons.length > 0) {
      markerReasonsByFile.set(file.relpath, markerReasons);
    }
  }

  return {
    effectiveSiteCount,
    effectiveFiles: [...effectiveFiles].sort(),
    liveSiteCount,
    liveFiles: [...liveFiles].sort(),
    markerReasonsByFile,
  };
}

/**
 * @param {string[]} [argv] - CLI-style argv (excluding the node binary and
 *   script path). Defaults to `process.argv.slice(2)` ONLY when omitted
 *   (`undefined`) — the sole change from the prior hardcoded read, so the
 *   CLI entrypoint below (`runMain(main)`, which calls `main()` with no
 *   args) is unaffected. Passing an explicit array (including `[]`) lets a
 *   caller — notably `tests/lint-allow-test-rule-refs.test.cjs`'s
 *   "repo baseline passes" row, #4060 — drive this function directly,
 *   in-process, with no subprocess and thus no `spawnSync` `timeout` to
 *   race against CI-load contention.
 */
async function main(argv = process.argv.slice(2)) {
  const args = argv;
  const unknown = args.filter((a) => a !== '--help');
  if (unknown.length > 0) {
    throw new ExitError(2, `lint-allow-test-rule-refs: unknown argument(s): ${unknown.join(', ')}`);
  }

  const globs = await deriveNoSourceGrepGlobs();
  const files = walkGlobs(globs, { testsDir: TESTS_DIR, extraRoot: EXTRA_ROOT, root: ROOT });
  const known = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
  const effectiveCeiling = JSON.parse(fs.readFileSync(EFFECTIVE_CEILING_PATH, 'utf8'));
  const unverifiedCeiling = JSON.parse(fs.readFileSync(UNVERIFIED_CEILING_PATH, 'utf8'));

  // Narrow the expensive Linter pass to marker-bearing files only (see
  // "Linter scope" doc comment above) — a plain in-memory substring scan
  // over content the walk already read, never a shell grep (NUL-byte
  // fixture, see comment). This is a strict superset filter: a file with no
  // `allow-test-rule:` substring at all cannot produce any genuine directive
  // (extractGenuineMarkerReasons requires the substring) or count toward
  // effective/unverified, so nothing is lost by skipping it here.
  const markerBearingFiles = files.filter((f) => f.content.includes('allow-test-rule:'));

  // classifySites does one Linter parse per marker-bearing file and returns
  // both the effective/live site classification AND (as a byproduct of that
  // SAME parse) every file's genuine marker reasons — the citation check and
  // exemption-file inventory below consume that instead of re-scanning file
  // content a second time.
  const { effectiveSiteCount, effectiveFiles, liveSiteCount, liveFiles, markerReasonsByFile } =
    classifySites(markerBearingFiles);

  const current = collectUncitedOffenders(markerReasonsByFile);
  const exemptionFiles = collectExemptionFiles(markerReasonsByFile);

  // Row 5 (#3520 test-matrix): a file with >=1 effective site counts ONLY as
  // effective, never also as unverified — no double counting.
  const effectiveFileSet = new Set(effectiveFiles);
  const unverifiedFiles = exemptionFiles.filter((f) => !effectiveFileSet.has(f));

  const failures = [];
  const { novel } = assertWithinAllowlist({
    label: 'allow-test-rule-refs',
    current,
    known,
    fail: (msg) => failures.push(msg),
    pruneHint: 'edit scripts/lint-allow-test-rule-refs.allowlist.json',
  });

  // Effective exemption SITES: tightly ratcheted, both directions — the
  // metric this gate actually governs.
  assertTightCeiling({
    label: 'allow-test-rule-effective-sites',
    actualMax: effectiveSiteCount,
    ceiling: effectiveCeiling.maxSites,
    grace: effectiveCeiling.grace,
    fail: (msg) => failures.push(`${msg}\n(edit scripts/lint-allow-test-rule-refs.effective-ceiling.json)`),
  });

  // Unverified marker-bearing FILES: a loose upper bound only — growth past
  // the ceiling fails, but a drop below it never does (test-matrix.md row 9;
  // shrinking this pool is a rule-coverage improvement, not something to
  // ratchet on deletion).
  if (unverifiedFiles.length > unverifiedCeiling.maxFiles) {
    failures.push(
      `[allow-test-rule-unverified-markers] ${unverifiedFiles.length} unverified marker-bearing ` +
        `file(s) exceeds ceiling ${unverifiedCeiling.maxFiles} (marker-bearing files with no ` +
        `detectable violation grew — audit the new markers before raising the ceiling; this is ` +
        `growth of the UNVERIFIED pool, distinct from the effective-sites ratchet above).\n` +
        `(edit scripts/lint-allow-test-rule-refs.unverified-ceiling.json)`
    );
  }

  // Live (unsuppressed) violations: this only covers MARKER-BEARING files
  // (see "Linter scope" doc comment above) — a live violation in a file with
  // NO marker at all is not re-checked here because `npx eslint .` /
  // `npm run lint` / `npm run lint:ci` already fail the build on those via
  // `local/no-source-grep` directly. Surfacing the marker-bearing subset
  // here makes it visible in this gate's own output rather than only in a
  // separate lint pass, without duplicating the repo-wide check.
  if (liveSiteCount > 0) {
    failures.push(
      `[allow-test-rule-live-violations] ${liveSiteCount} unsuppressed no-source-grep ` +
        `violation(s) found in ${liveFiles.length} marker-bearing file(s) (unmarked files are ` +
        `already enforced separately by npm run lint / npm run lint:ci; this gate only re-checks ` +
        `files that carry an allow-test-rule: marker) ` +
        `— fix at the source or add a site-scoped // allow-test-rule: <reason> (#NNN):\n` +
        liveFiles.map((f) => `  - ${f}`).join('\n')
    );
  }

  if (failures.length > 0) {
    for (const msg of failures) process.stderr.write(`${msg}\n`);
    if (novel.length > 0) {
      process.stderr.write(
        '\nNew allow-test-rule exemption without an issue ref — add `see #NNN` per ADR-456' +
          ' (docs/adr/456-test-rigor-architecture.md).\n'
      );
    }
    throw new ExitError(1);
  }

  console.log(
    `ok lint-allow-test-rule-refs: ${current.length} grandfathered exemption(s) tracked, ` +
      `no novel untracked offenders; ` +
      `effective exemptions: ${effectiveSiteCount}/${effectiveCeiling.maxSites} site(s) ` +
      `across ${effectiveFiles.length} file(s) (ratcheted); ` +
      `unverified markers: ${unverifiedFiles.length}/${unverifiedCeiling.maxFiles} file(s) ` +
      `(tracked, not ratcheted); ` +
      `live violations in marker-bearing files: ${liveSiteCount} (unmarked files are enforced ` +
      `separately by npm run lint / npm run lint:ci, not re-checked here). ` +
      `Known limit: "effective" is bounded by no-source-grep's own detection — ` +
      `identifier-indirection, dynamic paths, .sh files, and array/object round-trips are ` +
      `real blind spots this count cannot see, so it is never "all exemptions."`
  );
}

// Exported for tests/lint-allow-test-rule-refs.test.cjs (unit-level
// classification checks and the parity/teeth structural guard) — never
// re-implemented in the test file, imported directly like the CLI itself
// does. `runMain(main)` only fires when this file is executed as the CLI
// entrypoint (`node scripts/lint-allow-test-rule-refs.cjs` /
// `runNode([SCRIPT])`), not when it is `require()`d for its exports.
module.exports = {
  deriveNoSourceGrepGlobs,
  globBaseDir,
  globToRegExp,
  walkGlobs,
  collectUncitedOffenders,
  collectExemptionFiles,
  classifySiteLines,
  classifyFile,
  classifySites,
  classifyCode,
  main,
};

if (require.main === module) {
  runMain(main);
}

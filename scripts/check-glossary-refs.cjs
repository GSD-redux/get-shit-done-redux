#!/usr/bin/env node
'use strict';

/**
 * Verifies the machine-checkable claims in CONTEXT.md against the shipped
 * tree, so the glossary cannot silently re-rot the way the ADR index did
 * before scripts/gen-adr-index.cjs (#2340).
 *
 * Unlike gen-adr-index.cjs this gate has NO `--write` — CONTEXT.md's prose is
 * hand-authored, not a derived artifact this tool can regenerate. It only
 * verifies.
 *
 * Two checks:
 *
 *   A. File references resolve. Every backticked token in CONTEXT.md that
 *      looks like a file path — and whose path is inside a TRACKED_PREFIXES
 *      directory (or is one of the two named exact files) — must exist on
 *      disk. Everything else (generated bin/lib/*.cjs, `.planning/` runtime
 *      artifacts, `~/`- or `/`-rooted paths, bare filenames, example data
 *      shapes like `capability.json`) is deliberately ignored: asserting
 *      those would false-fail a clean checkout, which is the exact trap this
 *      gate exists to avoid falling into itself.
 *
 *   B. `allRuntimes` enum parity. CONTEXT.md documents the runtime enum's
 *      count and member list in prose (e.g. "Runtime enum: `allRuntimes` (17
 *      values: claude, ...)"). This is compared against the real
 *      `allRuntimes` array literal in bin/install.js — both the count and the
 *      member set — so adding/removing a runtime without updating the prose
 *      is caught.
 *
 * Usage:
 *   node scripts/check-glossary-refs.cjs           # print findings to stdout
 *   node scripts/check-glossary-refs.cjs --check    # exit 1 on any finding
 */

const fs = require('node:fs');
const path = require('node:path');

const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.resolve(__dirname, '..');
const CONTEXT_PATH = path.join(ROOT, 'CONTEXT.md');
const INSTALL_JS_PATH = path.join(ROOT, 'bin', 'install.js');

/**
 * Directory prefixes this gate can verify against the shipped tree. A token
 * outside these — most importantly `gsd-core/bin/lib/**`, which is generated
 * and gitignored — is not a claim this gate can check, so it is skipped
 * rather than asserted.
 */
const TRACKED_PREFIXES = [
  'src/',
  'tests/',
  'scripts/',
  'docs/',
  'gsd-core/references/',
  'gsd-core/workflows/',
  'gsd-core/templates/',
  'gsd-core/contexts/',
  '.github/',
  'eslint-rules/',
];

/** The only bare (no-prefix-match) tokens this gate checks by exact name. */
const TRACKED_EXACT = new Set(['bin/install.js', 'package.json']);

/**
 * Paths CONTEXT.md documents whose ABSENCE is the healthy steady state.
 *
 * `TRACKED_PREFIXES` skips claims this gate *cannot* check. This is the narrower
 * third case: a claim it must not check, because "does not exist" is the correct
 * state rather than drift.
 *
 * `tests/emitted-drift-ack.json` is the acknowledgment file from ADR-2719 §3. Its
 * whole design property is that it appears in the changed-files list ONLY when
 * something rippled unexpectedly — "touching it IS the alarm". A permanently
 * committed copy would signal nothing, which is exactly why the ADR rejected
 * shipping an empty stub. So the file is absent on a healthy `next` and present
 * only inside a PR that needs it, and asserting either way is wrong.
 *
 * The emitted-attribution family (`tests/fixtures/golden-install-parity`,
 * `tests/golden-install-parity.test.cjs`, `scripts/gen-golden-install-parity-zcode.cjs`,
 * `tests/agent-size-baseline.json`, `tests/workflow-size-baseline.json`,
 * `scripts/git-merge-regen-driver.cjs`, `scripts/update-size-baseline.cjs`) was RETIRED
 * by the #2724 cutover — the differential attribution check replaced the committed
 * baselines and their generator/bridge tooling. CONTEXT.md's RULESET.EMITTED_ATTRIBUTION
 * predicate documents that retirement ("Historically …"), so the mentions are history,
 * not live claims, and their absence is exactly the healthy state the retirement
 * produced. The whole documented family is listed, not just the members today's tick
 * parity happens to hide — the two tooling paths were invisible only because of where
 * line 585's inner backticks sat, which is the #2778 luck this gate must not rely on.
 *
 * `scripts/eslint-rules` appears only inside a CONTRASTIVE mention ("the local
 * plugin lives at `eslint-rules/` (repo root, NOT `scripts/eslint-rules/`)") — the
 * predicate asserts where the directory is NOT, so non-existence is the claim
 * being made, not drift away from one.
 *
 * Until #2778 this set's first entry passed only by accident: CONTEXT.md's
 * `RULESET.` entries are themselves backtick-wrapped and contain backticks, so the
 * sequential pairing in `extractTrackedRefs` happened to leave this token outside a
 * code span. Any edit that shifted the parity — such as #2778's own — exposed it.
 * A gate that passes by luck is not passing; naming the exemption makes the intent
 * explicit and survives the next edit. #3604 removed the luck itself (pairing is
 * per line), which is what surfaced the entries above: each names a path whose
 * absence is deliberate, so each is exempted by name for the same reason.
 */
const INTENTIONALLY_ABSENT = new Set([
  'tests/emitted-drift-ack.json',
  'tests/fixtures/golden-install-parity',
  'tests/golden-install-parity.test.cjs',
  'scripts/gen-golden-install-parity-zcode.cjs',
  'tests/agent-size-baseline.json',
  'tests/workflow-size-baseline.json',
  'scripts/git-merge-regen-driver.cjs',
  'scripts/update-size-baseline.cjs',
  'scripts/eslint-rules',
]);

/**
 * Shape a backticked token must have to even be considered a path candidate:
 * one or more `/`-separated segments of word/dot/dash characters, with an
 * optional trailing `:<line>` suffix. Anything else inside backticks (CLI
 * invocations with spaces, function signatures with parens/commas, bare
 * identifiers, env vars) is prose, not a path reference.
 */
const PATH_TOKEN_RE = /^[\w.-]+(?:\/[\w.-]+)*(?::\d+)?$/;

/** Whether `token` (line-suffix already stripped) is one this gate checks. */
function isTracked(token) {
  if (INTENTIONALLY_ABSENT.has(token)) return false;
  return TRACKED_EXACT.has(token) || TRACKED_PREFIXES.some((prefix) => token.startsWith(prefix));
}

/**
 * True if joining `token` to ROOT stays inside ROOT. `PATH_TOKEN_RE` admits `.`
 * inside a segment, so a token like `src/../../../etc/passwd` matches and (via
 * the `src/` prefix) reads as "tracked" — `path.join(ROOT, token)` would then
 * normalize to an out-of-tree absolute path and `fs.existsSync` would probe it,
 * turning a doc lint into a filesystem-existence oracle on the CI host. A
 * CONTEXT.md reference is always a plain in-repo path, so a `..` escape is never
 * legitimate: confine to ROOT and drop anything that climbs out.
 */
function isWithinRoot(token) {
  const resolved = path.resolve(ROOT, token);
  return resolved === ROOT || resolved.startsWith(ROOT + path.sep);
}

/**
 * Every distinct, trackable file-path token referenced in `text`, with any
 * trailing `:<line>` suffix stripped.
 *
 * #3604: pairing is per LINE, not over the whole text. A single whole-text pass
 * `[^`]+` crosses newlines, so one odd-backtick line (the `RULESET.*` predicate
 * format is backtick-wrapped and its values sometimes contain backticks) shifted
 * the pairing of every later line — a tracked token's visibility depended on
 * where it sat, which is how a renamed test file stayed invisible for weeks.
 *
 * The fact-store predicate lines (one `CLASS.subkey=value` fact per line,
 * backtick-wrapped as a whole) carry REAL paths in their values; the span itself
 * is not path-shaped (spaces, `=`), so a second pass harvests path-shaped tracked
 * tokens from inside any predicate-shaped span rather than letting the outer
 * wrapper hide them.
 *
 * Fragment guards: a real path in this repo never ends in `-` or `.` — those are
 * remnants of glob/template mentions (`scripts/gen-*.cjs`, `tests/foo.*.test.cjs`)
 * split at the `*` — and `NNNN` is the ADR filename template token
 * (CONTRIBUTING's "Do not compute a next number locally"), never a real path.
 */
function extractTrackedRefs(text) {
  const tokens = new Set();
  const add = (raw) => {
    if (!PATH_TOKEN_RE.test(raw)) return;
    const token = raw.replace(/:\d+$/, '');
    // Fragment guard, on the EMITTED token (after the :line strip, so
    // `src/foo-:12` is judged on `src/foo-`): glob/template remnants end in `-`
    // or `.`, a real path in this repo never does.
    if (!/[A-Za-z0-9_]$/.test(token)) return;
    if (token.includes('NNNN')) return;
    if (!isTracked(token)) return;
    if (!isWithinRoot(token)) return;
    tokens.add(token);
  };
  const subTokenRe = /[\w.-]+(?:\/[\w.-]+)*/g;
  for (const line of text.split(/\r?\n/)) {
    const re = /`([^`]+)`/g;
    let m;
    while ((m = re.exec(line)) !== null) {
      const span = m[1];
      if (PATH_TOKEN_RE.test(span)) {
        add(span);
        continue;
      }
      if (!/^[A-Z][A-Za-z0-9_.-]*=/.test(span)) continue;
      for (const sub of span.matchAll(subTokenRe)) add(sub[0]);
    }
  }
  return tokens;
}

/** Check A: every tracked reference must resolve on disk. */
function checkFileRefs(contextText) {
  const tokens = [...extractTrackedRefs(contextText)].sort();
  const findings = [];
  for (const token of tokens) {
    if (!fs.existsSync(path.join(ROOT, token))) {
      findings.push(`CONTEXT.md references \`${token}\` which does not exist in the repo.`);
    }
  }
  return { findings, checked: tokens.length };
}

/** The glossary's own claim: `Runtime enum: `allRuntimes` (N values: a, b, c)`. */
const ALLRUNTIMES_CLAIM_RE = /Runtime enum:\s*`allRuntimes`\s*\((\d+)\s*values:\s*([^)]*)\)/;

function parseClaimedRuntimes(contextText) {
  const m = contextText.match(ALLRUNTIMES_CLAIM_RE);
  if (!m) return null;
  return {
    count: Number(m[1]),
    members: m[2]
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  };
}

/** The real `allRuntimes = [...]` array literal in bin/install.js. */
const ALLRUNTIMES_ARRAY_RE = /allRuntimes\s*=\s*\[([^\]]*)\]/;

function parseRealRuntimes(installJsText) {
  const m = installJsText.match(ALLRUNTIMES_ARRAY_RE);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((mm) => mm[1]);
}

/** Check B: CONTEXT.md's prose count + member set must match bin/install.js. */
function checkAllRuntimesParity(contextText, installJsText) {
  const claimed = parseClaimedRuntimes(contextText);
  if (!claimed) {
    return [
      'CONTEXT.md is missing the `allRuntimes` enum-count sentence ' +
        '("Runtime enum: `allRuntimes` (N values: ...)") that this gate checks against bin/install.js.',
    ];
  }

  const real = parseRealRuntimes(installJsText);
  if (!real) {
    return ['bin/install.js does not contain a parseable `allRuntimes = [...]` array literal.'];
  }

  const findings = [];
  if (claimed.count !== real.length) {
    findings.push(
      `CONTEXT.md's allRuntimes enum-count sentence claims ${claimed.count} values but bin/install.js's ` +
        `allRuntimes array has ${real.length}.`,
    );
  }

  const claimedSet = new Set(claimed.members);
  const realSet = new Set(real);
  const missingFromProse = real.filter((r) => !claimedSet.has(r)).sort();
  const noLongerReal = claimed.members.filter((c) => !realSet.has(c)).sort();
  if (missingFromProse.length > 0 || noLongerReal.length > 0) {
    const parts = [];
    if (missingFromProse.length > 0) parts.push(`missing from CONTEXT.md's list: ${missingFromProse.join(', ')}`);
    if (noLongerReal.length > 0) parts.push(`no longer in bin/install.js's allRuntimes: ${noLongerReal.join(', ')}`);
    findings.push(`CONTEXT.md's allRuntimes member list has drifted from bin/install.js (${parts.join('; ')}).`);
  }

  return findings;
}

function main() {
  const [, , flag] = process.argv;

  const contextText = fs.readFileSync(CONTEXT_PATH, 'utf8');
  const installJsText = fs.readFileSync(INSTALL_JS_PATH, 'utf8');

  const fileRefs = checkFileRefs(contextText);
  const runtimeFindings = checkAllRuntimesParity(contextText, installJsText);
  const findings = [...fileRefs.findings, ...runtimeFindings];

  if (flag === '--check') {
    if (findings.length > 0) {
      process.stderr.write(`CONTEXT.md glossary has ${findings.length} drift finding(s).\n\n`);
      for (const f of findings) process.stderr.write(`  ✗ ${f}\n`);
      process.stderr.write('\n');
      throw new ExitError(1);
    }
    process.stdout.write(
      `CONTEXT.md glossary references are current (${fileRefs.checked} refs checked, allRuntimes parity ok).\n`,
    );
    return;
  }

  if (findings.length === 0) {
    process.stdout.write(
      `CONTEXT.md glossary references are current (${fileRefs.checked} refs checked, allRuntimes parity ok).\n`,
    );
  } else {
    process.stdout.write(`CONTEXT.md glossary has ${findings.length} drift finding(s):\n\n`);
    for (const f of findings) process.stdout.write(`  ✗ ${f}\n`);
  }
}

runMain(main);

// allow-test-rule: source-text-is-the-product (#2751)
'use strict';

// Regression guard for #2751: agents/*.md and gsd-core/workflows/*.md must not
// instruct an agent to invoke a BARE `gsd-tools <verb> <args>` command. The bare
// word fails with "command not found" on a shim-only install (no `gsd-tools`
// binary on PATH) — every such instruction must use the `gsd_run` resolver the
// same files already define. #725 fixed this only for the Codex install-
// conversion pipeline; the Claude-facing SOURCE shipped the bare calls verbatim
// until #2751 normalized them.
//
// A pure regex cannot perfectly distinguish an imperative ("Use `gsd-tools query
// commit` to commit") from a descriptive mention ("`gsd-tools query commit`
// returns an envelope") — both contain the same command phrase. So this guard
// scans for `gsd-tools <verb> <arg>` (the operative shape — a verb followed by
// its arguments) and subtracts a documented ALLOWLIST of known descriptive
// mentions that NAME the command without instructing literal invocation. Any
// site NOT in the allowlist is a new operative bare call and fails the gate.
//
// Verb coverage is derived LIVE from the gsd-tools host-command router
// (`gsd-core/bin/gsd-tools.cjs`) by reading the `'verb': routeHandler` / `verb:
// routeHandler` entries. This is deliberate — the original #2751 guard used a
// hand-maintained 6-verb list that silently false-passed `verify-summary` (the
// `verify` branch matched the prefix, then died on the hyphen), and missed
// `windows`, `worktree`, `smart-entry`, and `quick-tasks-append` entirely.
// Deriving the set from the router means a new verb registered there is covered
// here the moment it lands — no second list to keep in sync.
//
// Source-text guard: the deployed contract IS the markdown text the runtime
// loads. Scans FULL file text (the real hits lived in inline prose/table cells,
// not fenced bash blocks).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ROUTER_PATH = path.join(ROOT, 'gsd-core', 'bin', 'gsd-tools.cjs');
const SCAN_DIRS = ['agents', path.join('gsd-core', 'workflows')];

// Derive the verb set the bare-call guard matches against. Most top-level
// verbs live in the host-command router table as `'verb': routeHandler` entries
// (~70); this reads those dynamically so new router verbs are covered the moment
// they land. A handful of verbs are dispatched as FAMILIES (their own
// `command === 'verb'` arm, not a route-table entry): `query` (line ~2876),
// `intel`, `verify`, and `graphify`. These are stable, documented families, so
// they are supplemented explicitly here rather than parsed from the help string
// (whose prose mixes real verbs with English words like "for"/"output"/"working",
// producing noise). If a family verb is ever promoted into the route table the
// union dedupes harmlessly; if a NEW family verb is added it must be added here.
//
// Sorted longest-first so a hyphenated verb (`verify-summary`) is preferred over
// its prefix (`verify`) — the exact ordering bug that let `verify-summary` slip
// past a fixed 6-verb list during the first #2751 pass.
const FAMILY_DISPATCHED_VERBS = ['query', 'intel', 'verify', 'graphify'];
function readRouterVerbs() {
  const src = fs.readFileSync(ROUTER_PATH, 'utf8');
  const re = /(?:'([a-z][a-z-]*)'|([a-z][a-z-]*))\s*:\s*route[A-Z]\w*/g;
  const verbs = new Set(FAMILY_DISPATCHED_VERBS);
  let m;
  while ((m = re.exec(src)) !== null) verbs.add(m[1] || m[2]);
  return [...verbs].sort((a, b) => b.length - a.length);
}

const VERBS = readRouterVerbs();

// Operative shape: `gsd-tools <known-verb>` followed by whitespace and a real
// argument (the verb is NOT the close of a code span — there is a real arg
// after it). Restricting to KNOWN verbs (vs any `[a-z-]+` token) avoids
// false-flagging English prose like "gsd-tools through the ...".
const BARE_COMMAND_RE = new RegExp(
  String.raw`(?:^|[^./A-Za-z0-9_-])gsd-tools\s+(` + VERBS.join('|') + String.raw`)\s+[^\s` + '`' + String.raw`]`
);

// Lines that legitimately embed `gsd-tools <verb> <arg>` but are descriptive, not
// command-position: they NAME the command (in prose / parenthetical examples /
// return-envelope descriptions) rather than instructing an agent to run the bare
// word. Keyed `file:line` so a rewording that moves the mention forces a conscious
// allowlist update rather than silently passing.
//
// Each entry MUST carry a one-line reason; the test prints the allowlist on
// failure so a reviewer can see exactly what is sanctioned.
const PROSE_ALLOWLIST = [
  { file: 'agents/gsd-executor.md', line: 791, reason: 'describes the SDK return envelope of `gsd-tools query commit`; not an instruction to run the bare word' },
  { file: 'agents/gsd-phase-researcher.md', line: 33, reason: 'package-legitimacy provenance rule names the command as the source of an OK verdict; descriptive' },
  { file: 'agents/gsd-roadmapper.md', line: 624, reason: 'parenthetical "e.g." naming SDK queries a user *could* run; not an agent instruction' },
  { file: 'agents/gsd-intel-updater.md', line: 40, reason: 'cross-platform note names the `gsd-tools intel <subcommand>` CLI surface descriptively ("CLI invocations go through..."); not an agent instruction' },
  { file: 'gsd-core/workflows/execute-plan.md', line: 387, reason: 'describes the downstream SDK validation step (`validated downstream by ...`); names the mechanism, does not instruct the agent to type it' },
  { file: 'agents/gsd-research-synthesizer.md', line: 65, reason: 'a code comment inside a fenced block explaining what the commit step loads (`# Planning config loaded via gsd-tools query ...`); descriptive, not an invocation — and explicitly names gsd-tools.cjs as the alternative' },
];

// Resolver-snippet definition lines / probes that must never be flagged. A line
// is a resolver/probe definition when it assigns the shim name, probes PATH, or
// assigns GSD_TOOLS / defines the gsd_run function — NOT merely when it contains
// the substring `gsd-tools.cjs` (which would blanket-exempt any prose that
// happens to name the file).
const EXCLUSION_RE = /_GSD_SHIM_NAME\s*=|command -v gsd-tools|\bGSD_TOOLS\s*=|gsd_run\s*\(\)\s*\{/;

function collectMdFiles(dir) {
  const results = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMdFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

function findBareCommandPositionCalls() {
  const offenders = [];
  for (const scanDir of SCAN_DIRS) {
    const abs = path.join(ROOT, scanDir);
    for (const file of collectMdFiles(abs)) {
      // Normalize to forward slashes so the file:line PROSE_ALLOWLIST keys match
      // identically on every OS — path.relative() returns backslash separators on
      // Windows, which would defeat the allowlist lookup and false-flag the 6
      // descriptive mentions (#2751 Windows CI failure).
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (EXCLUSION_RE.test(line)) continue;
        const match = line.match(BARE_COMMAND_RE);
        if (!match) continue;
        const loc = `${rel}:${i + 1}`;
        const allowed = PROSE_ALLOWLIST.find((a) => a.file === rel && a.line === i + 1);
        if (allowed) continue;
        offenders.push({ loc, verb: match[1], text: line.trim() });
      }
    }
  }
  return offenders;
}

test('verb set was derived from the router (guards against a silent extraction regression)', () => {
  // If the router is refactored so the `routeHandler` pattern no longer matches,
  // VERBS would be empty and the bare-call guard below would false-pass
  // everything. Sanity-bound it: a healthy router exposes many host verbs.
  assert.ok(
    VERBS.length > 40,
    `Expected to derive >40 verbs from ${path.relative(ROOT, ROUTER_PATH)}, got ${VERBS.length}. ` +
      'If the router table changed shape, update readRouterVerbs() so the guard keeps coverage.'
  );
  // Longest-first ordering is what lets verify-summary win over verify.
  const sample = ['verify-summary', 'verify', 'query', 'intel', 'graphify', 'windows', 'worktree', 'smart-entry', 'commit', 'check'];
  for (const v of sample) {
    assert.ok(VERBS.includes(v), `expected verb '${v}' in derived set (router/family drift?)`);
  }
});

test('no command-position bare gsd-tools <verb> survives in agents/ or workflows/ (#2751)', () => {
  const offenders = findBareCommandPositionCalls();
  assert.strictEqual(
    offenders.length,
    0,
    'Bare `gsd-tools <verb> <args>` command-position calls must use the `gsd_run` ' +
      'resolver (they fail with "command not found" on a shim-only install — #2751). ' +
      `Found ${offenders.length} offender(s):\n` +
      offenders.map((o) => `  ${o.loc} [${o.verb}] ${o.text}`).join('\n') +
      '\n\nIf a hit is a descriptive prose mention (not an instruction to run the bare ' +
      'word), add it to PROSE_ALLOWLIST in this test with a reason.'
  );
});

test('every PROSE_ALLOWLIST entry still matches a real gsd-tools mention (no stale allowlist entries)', () => {
  // An allowlist entry that no longer matches anything is stale — it was either
  // fixed (remove it) or the line moved (update it). Either way it must not linger.
  const stale = [];
  for (const entry of PROSE_ALLOWLIST) {
    const file = path.join(ROOT, entry.file);
    let lines;
    try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/); } catch (e) {
      stale.push({ ...entry, problem: 'file missing' });
      continue;
    }
    const line = lines[entry.line - 1];
    if (!line || !BARE_COMMAND_RE.test(line) || EXCLUSION_RE.test(line)) {
      stale.push({ ...entry, problem: 'line no longer matches a bare gsd-tools mention', actual: line ? line.trim() : '(line absent)' });
    }
  }
  assert.strictEqual(
    stale.length,
    0,
    'PROSE_ALLOWLIST has stale entries (the mentioned line no longer carries a bare ' +
      '`gsd-tools <verb> <arg>` mention). Remove or update them:\n' +
      stale.map((s) => `  ${s.file}:${s.line} — ${s.problem}${s.actual ? ` (actual: ${s.actual.slice(0, 80)})` : ''}`).join('\n')
  );
});

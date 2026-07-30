// allow-test-rule: source-text-is-the-product
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
// Source-text guard: the deployed contract IS the markdown text the runtime
// loads. Scans FULL file text (the real hits lived in inline prose/table cells,
// not fenced bash blocks).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['agents', path.join('gsd-core', 'workflows')];

const VERBS = ['query', 'check', 'verify', 'intel', 'loop', 'graphify'];

// Operative shape: `gsd-tools <verb>` followed by a space and a command argument
// (the verb is NOT the close of a code span — there is a real arg after it).
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
];

// Resolver-snippet definition lines / probes that must never be flagged.
const EXCLUSION_RE = /gsd-tools\.cjs|command -v gsd-tools|\bGSD_TOOLS=|_GSD_SHIM_NAME/;

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
      const rel = path.relative(ROOT, file);
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

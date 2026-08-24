'use strict';

// Guard: runtime-loaded markdown must not carry a reference an AI runtime will try to
// LOCATE on the filesystem. When a runtime meets a file-shaped token it cannot resolve,
// it falls back to searching for it — and on Git Bash for Windows `find /` maps to the
// drive root, so `find.exe` traverses the whole disk (orphaned processes, handle leak,
// a pegged core until someone reaps it by hand).
//
// The guard is a RULE TABLE, deliberately, because the first version of it was not.
//
//   #2020 shipped a guard hardcoded to `sdk/(src|dist|handlers)/` — the three dead paths
//   that had caused the storm. That is an instance fix wearing a regression test: it
//   proved those three paths were gone and said nothing about the class. Seven weeks
//   later #3809 reproduced the identical storm under a different token, and the guard
//   was structurally incapable of seeing it. Adding a rule here must stay a one-entry
//   change, so the next recurrence is a table row rather than a third incident.
//
// Scope: the markdown a runtime actually loads and resolves references against —
// agents/, gsd-core/workflows/, gsd-core/references/, commands/. Prose mentions inside
// *.cjs sources are out of scope: nothing tries to locate those.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SCAN_DIRS = ['agents', 'gsd-core/workflows', 'gsd-core/references', 'commands'];

// ---------------------------------------------------------------------------
// Rule A (#2020) — a dead SDK file-path reference. The SDK package was retired
// by ADR-0174, so these paths never resolve and a runtime will hunt for them.
// ---------------------------------------------------------------------------
const DEAD_SDK_REF = /sdk\/(?:src|dist|handlers)\//;

// ---------------------------------------------------------------------------
// Rule B (#3809) — the runtime shim named in COMMAND position.
//
// The shim filename is not a command on any platform. package.json `bin` ships
// `gsd-core`, `gsd-tools`, `gsd_run`, `gsd-mcp-server`; the .cjs file exists only at
// <runtime-root>/gsd-core/bin/. CONTEXT.md -> Runtime Launcher Module makes `gsd_run`
// the single sanctioned entry point: "Canonical space-safe shell preamble (`gsd_run`)
// used by every workflow bash block to invoke the GSD runtime CLI."
//
// So a workflow that says `<shim> query phase.add` instructs the agent to run something
// that exits 127, after which the file-shaped token sends it looking for the file.
//
// What separates an INVOCATION from the four legitimate ways this filename appears is
// the token that follows it. Being lenient here is the entire point — the guard must
// not flag the launcher's own resolver, a real `node <path>/<shim>` call, a bare path,
// or prose that simply names the file. See the negative-space rows below, each of which
// is a form that exists in the tree today and must keep working.
// ---------------------------------------------------------------------------

// Built at runtime so this line is not itself an invocation the guard would flag.
const SHIM = ['gsd-tools', '.cjs'].join('');
const SHIM_RE = new RegExp(
  // not preceded by a path separator, word char, or hyphen (excludes `<dir>/<shim>`)
  `(?<![\\w./\\\\-])${SHIM.replace(/\./g, '\\.')}` +
    // at least one space or tab, then the following token
    '[ \\t]+([a-z][a-z0-9.-]*)',
  'g',
);

// Bare CLI verbs that are unmistakably subcommands rather than English prose.
// Everything else is recognised structurally: a dotted or hyphenated token
// (`phase.add`, `audit-open`, `detect-custom-files`) is subcommand-shaped and never a
// word in a sentence. This is what keeps "…the <shim> file lives in bin" unflagged
// while still catching a verb nobody has added yet.
const BARE_VERBS = new Set(['query', 'commit', 'effort']);

/**
 * Subcommand tokens invoked on the bare shim in one line of markdown.
 * Returns [] for every legitimate form. Pure — no filesystem access.
 */
function findShimInvocations(line) {
  // The canonical launcher's own single source of truth assigns the filename.
  if (line.includes('_GSD_SHIM_NAME=')) return [];

  const found = [];
  let m;
  SHIM_RE.lastIndex = 0;
  while ((m = SHIM_RE.exec(line)) !== null) {
    // `node <path>/<shim> <verb>` is resolvable and fine. `node <shim> <verb>` is NOT —
    // node resolves a bare filename against cwd, so it fails exactly like the bare form.
    // The exemption therefore requires a real path separator before the shim.
    if (/\bnode[ \t]+["']?[^ \t"']*[/\\]$/.test(line.slice(0, m.index))) continue;
    const token = m[1];
    if (BARE_VERBS.has(token) || token.includes('-') || token.includes('.')) {
      found.push(token);
    }
  }
  return found;
}

const RULES = [
  {
    id: '#2020',
    label: 'dead SDK file reference',
    remedy: 'the SDK package was retired (ADR-0174) — point at a live path',
    scan: (line) => (DEAD_SDK_REF.test(line) ? ['sdk/'] : []),
  },
  {
    id: '#3809',
    label: `bare \`${SHIM}\` invocation`,
    remedy: 'call the canonical launcher instead: `gsd_run <subcommand>`',
    scan: findShimInvocations,
  },
];

function walkMd(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkMd(full, out);
    else if (e.isFile() && e.name.endsWith('.md')) out.push(full);
  }
  return out;
}

/** Offenders for one rule across every runtime-loaded markdown file. */
function scanTree(rule) {
  const offenders = [];
  for (const rel of SCAN_DIRS) {
    for (const file of walkMd(path.join(ROOT, rel))) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
      lines.forEach((line, i) => {
        for (const hit of rule.scan(line)) {
          offenders.push(`${path.relative(ROOT, file)}:${i + 1}  (${hit})`);
        }
      });
    }
  }
  return offenders;
}

describe('runtime-loaded markdown carries no unresolvable reference', () => {
  for (const rule of RULES) {
    test(`${rule.id} — no ${rule.label} in ${SCAN_DIRS.join(', ')}`, () => {
      const offenders = scanTree(rule);
      assert.deepEqual(
        offenders,
        [],
        `${rule.id}: ${offenders.length} ${rule.label}(s) found. Runtimes resolve these by ` +
          `filesystem search — on Git Bash for Windows that is a full-drive find.exe storm.\n` +
          `Remedy: ${rule.remedy}.\n${offenders.join('\n')}`,
      );
    });
  }
});

describe('#3809 — what counts as a bare shim invocation', () => {
  // Positive space: forms that send an agent hunting for the file.
  const INVOCATIONS = [
    ['inline code in prose', `**Delegate the phase addition to \`${SHIM} query phase.add\`:**`, 'query'],
    ['command substitution', `- \`ROADMAP=$(${SHIM} query roadmap.analyze)\``, 'query'],
    ['dotted subcommand', `\`${SHIM} query state.add-roadmap-evolution ...\``, 'query'],
    ['hyphenated subcommand', `Use \`${SHIM} detect-custom-files\``, 'detect-custom-files'],
    ['bare verb, no backticks', `# config settings can be fetched via ${SHIM} query config-get`, 'query'],
    ['commit verb', `via \`${SHIM} commit-to-subrepo\`. File paths are relative`, 'commit-to-subrepo'],
  ];

  for (const [name, line, expected] of INVOCATIONS) {
    test(`flags ${name}`, () => {
      assert.deepEqual(findShimInvocations(line), [expected]);
    });
    test(`flags ${name} with a CRLF line ending`, () => {
      // A trailing \r must not defeat the match — this repo has a documented
      // bug class of regexes that only ever saw \n.
      assert.deepEqual(findShimInvocations(`${line}\r`), [expected]);
    });
  }

  // Negative space: every legitimate way the filename appears in the tree today.
  // Each row is a real line; flagging any of them would be an over-broad fix.
  const LEGITIMATE = [
    ['the launcher resolver assignment', `_GSD_SHIM_NAME="${SHIM}"; _GSD_RUNTIME_ROOT="\${RUNTIME_DIR:-$(pwd)}"`],
    ['a node-prefixed invocation', `  node <config-dir>/gsd-core/bin/${SHIM} restore-custom-files \\`],
    ['a quoted node-prefixed invocation', `node "$GSD_DIR/gsd-core/bin/${SHIM}" query commit`],
    ['a qualified path with no subcommand', `  "$PREFERRED_CONFIG_DIR/gsd-core/bin/${SHIM}" \\`],
    ['prose naming the file', `# Resolve ${SHIM} WITHOUT yet knowing GSD_DIR. The running workflow lives`],
    ['prose whose next token is an English word', `# shim-only install (${SHIM} present, \`gsd-tools\` not on PATH) the bare call exits`],
    ['prose with a lowercase English word after', `the ${SHIM} file lives under gsd-core/bin`],
    ['the filename at end of line', `authoritative tool for THIS install is ${SHIM}`],
  ];

  for (const [name, line] of LEGITIMATE) {
    test(`ignores ${name}`, () => {
      assert.deepEqual(findShimInvocations(line), []);
    });
  }

  // `node <shim>` with no directory is NOT exempt: node resolves a bare filename
  // against cwd, so it fails exactly like the bare form (found at
  // gsd-core/references/model-profiles.md:231).
  test('flags a node-prefixed shim that carries no path', () => {
    assert.deepEqual(findShimInvocations(`\`node ${SHIM} effort sync --apply\``), ['effort']);
  });

  // Boundary: the separator between the filename and the subcommand.
  test('zero separating spaces is not an invocation (limit-1)', () => {
    assert.deepEqual(findShimInvocations(`\`${SHIM}query\``), []);
  });
  test('exactly one separating space is an invocation (limit)', () => {
    assert.deepEqual(findShimInvocations(`\`${SHIM} query\``), ['query']);
  });
  test('more than one separating space is still an invocation (limit+1)', () => {
    assert.deepEqual(findShimInvocations(`\`${SHIM}   query\``), ['query']);
    assert.deepEqual(findShimInvocations(`\`${SHIM}\tquery\``), ['query']);
  });

  // Properties — the matcher is a parser, so pin its two directional invariants.
  test('property: a path-qualified or node-prefixed shim is never flagged', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('node ', 'node "', "node '", '/', './', '../', 'gsd-core/bin/', '$DIR/'),
        fc.constantFrom('query', 'commit', 'phase.add', 'audit-open', 'from-gsd2'),
        (prefix, verb) => {
          const line = prefix.endsWith('/')
            ? `  ${prefix}${SHIM} ${verb}`
            : `  ${prefix}gsd-core/bin/${SHIM} ${verb}`;
          assert.deepEqual(findShimInvocations(line), []);
        },
      ),
      { numRuns: 200 },
    );
  });

  test('property: a bare shim followed by a subcommand is always flagged', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('', '`', '$(', '- ', 'run ', '**via '),
        fc.constantFrom('query', 'commit', 'phase.add', 'audit-open', 'from-gsd2', 'commit-to-subrepo'),
        fc.integer({ min: 1, max: 4 }),
        (prefix, verb, spaces) => {
          const line = `${prefix}${SHIM}${' '.repeat(spaces)}${verb}`;
          assert.deepEqual(findShimInvocations(line), [verb]);
        },
      ),
      { numRuns: 300 },
    );
  });
});

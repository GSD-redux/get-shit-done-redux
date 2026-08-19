'use strict';

// allow-test-rule: source-text-is-the-product (#3576) — this gate reads shipped
// runtime-loaded .md files and asserts on their literal citation text; the text IS
// the deployed contract, so reading it is the behavior under test.

/**
 * #3576 — dead-citation gate for the shipped trees.
 *
 * A backticked bare `references/<name>.md` cite resolves from NO install location:
 * agents install to ~/.claude/agents/, workflows to ~/.claude/gsd-core/workflows/,
 * references to a sibling of workflows — a bare relative `references/` path is dead
 * from every one of them. The canonical form (what every <required_reading> block
 * and @~/ include already uses) is `gsd-core/references/<file>.md`.
 *
 * #3206 fixed one file; PR #3435 swept agents/gsd-verifier.md and stopped at its
 * scope. This gate ends the class (epic #3473's B6 shape; #3518's drift guard is
 * the precedent). Scope: the runtime-loaded trees the issue prescribes — agents/,
 * gsd-core/{workflows,references,templates,contexts}, commands/, capabilities/.
 * docs/ (incl. translations) is deliberately OUT: human-facing, per-locale drift,
 * ranked lower severity by the issue — the recorded remainder.
 *
 * The trap the issue names: a guard that skips whole LINES containing `@~/` misses
 * a bare cite sharing a line with an include — strip only the `@~/…` token.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');

const SCAN_ROOTS = [
  'agents',
  'gsd-core/workflows',
  'gsd-core/references',
  'gsd-core/templates',
  'gsd-core/contexts',
  'commands',
  'capabilities',
];

// A bare cite is BACKTICK-ANCHORED: `` `references/x.md` ``. The anchor is what
// excludes the genuinely relative href (`../references/…` — its backtick precedes
// `..`, not `references/`) and non-backticked prose mentions.
const BARE_CITE_RE = /`references\/([a-z0-9-]*\.md)`/g;
// The @~/ include token, stripped PER-TOKEN (never line-wise) before scanning.
const INCLUDE_TOKEN_RE = /@~\/[^\s`]+/g;

function walkShippedMarkdown() {
  const files = [];
  for (const root of SCAN_ROOTS) {
    const rootDir = path.join(REPO_ROOT, root);
    if (!fs.existsSync(rootDir)) continue;
    // readdirSync returns platform-separated relative paths; normalize
    // unconditionally (repo convention) so diagnostics read identically on Windows.
    for (const f of fs.readdirSync(rootDir, { recursive: true })) {
      const normalized = String(f).split(path.sep).join('/');
      if (normalized.endsWith('.md')) files.push({ rel: `${root}/${normalized}`, abs: path.join(rootDir, f) });
    }
  }
  return files;
}

/** Find bare cites in one document, after per-token @~/ stripping. */
function findBareCites(text) {
  const stripped = text.replace(INCLUDE_TOKEN_RE, '');
  const offenders = [];
  let m;
  while ((m = BARE_CITE_RE.exec(stripped)) !== null) {
    offenders.push(`references/${m[1]}`);
  }
  return offenders;
}

/** Canonical `gsd-core/references/<name>` cites (backticked) — targets must exist. */
function findCanonicalCites(text) {
  const re = /`gsd-core\/references\/([a-z0-9-]*\.md)`/g;
  const found = [];
  let m;
  while ((m = re.exec(text)) !== null) found.push(m[1]);
  return found;
}

describe('#3576 gate: shipped reference citations resolve', () => {
  test('#3576 gate: no bare references/ cites across shipped trees', () => {
    const offenders = [];
    for (const { rel, abs } of walkShippedMarkdown()) {
      // allow-test-rule: source-text-is-the-product (#3576) — shipped text is the runtime contract
      const text = fs.readFileSync(abs, 'utf-8');
      for (const cite of findBareCites(text)) {
        offenders.push(`${rel}: \`${cite}\` — bare cite resolves from no install location; use \`gsd-core/${cite}\``);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'Bare `references/<name>.md` cites are dead pointers at runtime (#3576). '
        + 'Rewrite to the canonical `gsd-core/references/<file>.md` form:\n'
        + offenders.join('\n'),
    );
  });

  test('#3576 gate: every canonical reference cite target exists on disk', () => {
    const missing = [];
    for (const { rel, abs } of walkShippedMarkdown()) {
      // allow-test-rule: source-text-is-the-product (#3576) — shipped text is the runtime contract
      const text = fs.readFileSync(abs, 'utf-8');
      for (const name of findCanonicalCites(text)) {
        if (!fs.existsSync(path.join(REPO_ROOT, 'gsd-core', 'references', name))) {
          missing.push(`${rel}: \`gsd-core/references/${name}\` — target does not exist`);
        }
      }
    }
    assert.deepEqual(missing, [], 'Canonical cites must name files that exist:\n' + missing.join('\n'));
  });

  test('#3576 gate unit: @~/ token stripped per-token, never line-skipped; relative and canonical forms pass', () => {
    const includePlusBare = 'Read @~/gsd-core/references/tdd.md and `references/tdd.md` too';
    assert.deepEqual(
      findBareCites(includePlusBare),
      ['references/tdd.md'],
      'a bare cite sharing a line with an @~/ include must still be flagged (the issue-named trap)',
    );
    assert.deepEqual(findBareCites('see `../references/mvp-concepts.md`'), [], 'genuinely relative href is not a bare cite');
    assert.deepEqual(findBareCites('see `gsd-core/references/tdd.md`'), [], 'canonical cite is not a bare cite');
    assert.deepEqual(findBareCites('the references/ directory'), [], 'non-backticked prose mention is not a cite');
    assert.deepEqual(findBareCites('Read @~/gsd-core/references/tdd.md now'), [], 'a lone @~/ include line is clean after stripping');
  });
});

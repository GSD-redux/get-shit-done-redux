'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// #3763 — every `config-get` command substitution in shipped content passes
// `--raw` (or is an exempt JSON consumer).
//
// `query config-get <key>` without `--raw` prints `JSON.stringify(value)`, so
// a STRING-typed value reaches a bash variable with embedded literal quotes
// (`RUNTIME='"claude"'`) and every downstream `[ "$X" = "y" ]` / `case "$X"`
// comparison silently never matches. Boolean and numeric values are identical
// either way, which is exactly why the string sites survived testing.
//
// Exempt shapes (consumers that WANT JSON — an object/array value):
//   * the receiving variable's name ends in `_JSON`
//   * the call carries a JSON-array default (`--default '[]'` / `--default "[]"`)
// Anything else that command-substitutes config-get must pass `--raw`.
// ─────────────────────────────────────────────────────────────────────────────

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const SCAN_ROOTS = [
  'gsd-core/workflows',
  'commands',
  'agents',
  'skills',
];

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.md')) out.push(full);
  }
  return out;
}

// A config-get COMMAND SUBSTITUTION: any command substitution containing
// config-get — `$(gsd_run query config-get ...)`, `$(gsd-tools ... config-get
// ...)`, etc. Prose mentions (no `$(`) do not match; nested `$( )` inside the
// substitution is not a shape the shipped trees use for config-get calls.
const SUBSTITUTION_RE = /\$\([^)]*config-get[^)]*\)/g;

test('#3763: every config-get command substitution in shipped content passes --raw (or is an exempt JSON consumer)', () => {
  const files = [];
  for (const root of SCAN_ROOTS) walk(path.join(REPO_ROOT, root), files);

  const offenders = [];
  let scannedSubstitutions = 0;
  for (const file of files) {
    const rel = path.relative(REPO_ROOT, file);
    const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line.includes('config-get')) continue;
      const subs = line.match(SUBSTITUTION_RE) || [];
      for (const sub of subs) {
        scannedSubstitutions++;
        // --raw must sit in the config-get command itself, before any `||`
        // fallback — an `echo "" --raw` fallback arg would otherwise
        // false-pass the check while config-get still lacks the flag.
        const cmd = sub.slice(0, sub.indexOf('||') >= 0 ? sub.indexOf('||') : sub.length);
        if (cmd.includes('--raw')) continue;
        // Exempt shapes: a JSON-consuming variable name, or an explicit
        // JSON-array default — the caller wants JSON.stringify output.
        const varMatch = /^\s*[A-Za-z_][A-Za-z0-9_]*=/.exec(line);
        const varName = varMatch ? varMatch[0].trimEnd().slice(0, -1) : '';
        if (varName.endsWith('_JSON')) continue;
        if (/--default\s+('\[\]'|"\[\]")/.test(sub)) continue;
        offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    }
  }

  assert.ok(scannedSubstitutions > 20,
    `guard self-check: expected to scan dozens of config-get substitutions, found ${scannedSubstitutions} — the scan roots or matcher rotted`);
  assert.deepEqual(
    offenders,
    [],
    `#3763: config-get command substitutions without --raw feed JSON.stringify output into bash string comparisons (they silently never match for string values). Add --raw, or rename the receiving variable to *_JSON / pass a '[]' default if the consumer parses JSON. Offenders:\n${offenders.join('\n')}`,
  );
});

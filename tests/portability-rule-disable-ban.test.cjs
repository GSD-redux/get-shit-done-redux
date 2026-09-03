'use strict';

/**
 * portability-rule-disable-ban.test.cjs
 *
 * Out-of-band disable-ban scan (ADR-1703).
 *
 * ESLint inline suppression of portability rules is banned. This test runs
 * OUTSIDE ESLint so it cannot itself be eslint-disabled.
 *
 * PROTECTED_RULES grows as later phases add rules. Each new portability rule
 * in the `local/` namespace should be appended to this list.
 *
 * Hard-fails on:
 *   (a) Any `eslint-disable*` comment that NAMES a protected portability rule.
 *   (b) Any BLANKET `eslint-disable*` comment (no rule list) — these suppress
 *       every rule including the protected ones.
 *
 * NOTE: This file itself is excluded from the scan by absolute path. It
 * references the disable keyword only inside regex/string data structures to
 * avoid being detected as a real directive.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const espree = require('espree');
const tsEstree = require('@typescript-eslint/typescript-estree');
const { globSync } = require('glob');

// ── Protected portability rules (grows with each ADR-1703 phase) ──────────────
const PROTECTED_RULES = [
  'no-path-literal-in-assert',
  'no-posix-mode-bit-assert',
  'no-unguarded-nonportable-exec',
  // ADR-1703 Phase 4 rules (issue #1726)
  'no-crlf-fragile-split',
  'no-hardcoded-tmp',
  'no-bare-npm-exec',
  'require-userprofile-with-home',
  // ADR-1703 Phase 5 rule (issue #1733) — applies to src/**/*.cts (production sources)
  'normalize-path-in-content',
  // ADR-1703 Phase 6 rule (issue #1740) — applies to src/**/*.cts AND the build/install
  // surface (bin/install.js, scripts/build-hooks.js) brought under lint by the glob expansion
  'require-fs-op-fallback',
  // #4244 hardening (origin #4020 / #4220 Windows CI hang) — applies to tests/**/*.test.cjs
  'require-full-tmpdir-triad',
  'no-unbounded-dirname-walk',
];

// ── Detect disable directives via the comment text ───────────────────────────

// The three directive forms ESLint recognises (built as concatenated strings so
// this source file contains NO real disable directive of its own).
const D = 'eslint-' + 'disable';
const DN = 'eslint-' + 'disable-next-line';
const DL = 'eslint-' + 'disable-line';
const DISABLE_PREFIXES = [DN, DL, D]; // longest first so prefix-match is greedy

/**
 * Classify a comment node.  Returns:
 *   'blanket'   — a disable with NO rule list (suppresses everything)
 *   'named'     — a disable that lists at least one protected portability rule
 *   null        — not a disable directive, or a non-portability named disable
 */
function classifyComment(commentValue) {
  const txt = commentValue.trim();
  for (const prefix of DISABLE_PREFIXES) {
    if (txt.startsWith(prefix)) {
      // Text after the directive keyword
      const rest = txt.slice(prefix.length).trim();
      // Blanket: nothing after the keyword, or only a prose comment (starts with --)
      if (!rest || rest.startsWith('--')) {
        return 'blanket';
      }
      // Named: rest is a comma-separated rule list (possibly with -- prose)
      const ruleList = rest.split('--')[0]; // strip trailing prose
      const rules = ruleList.split(',').map(r => r.trim()).filter(Boolean);
      for (const rule of rules) {
        for (const protected_ of PROTECTED_RULES) {
          if (rule === 'local/' + protected_ || rule === protected_) {
            return 'named';
          }
        }
      }
      return null; // named disable but not for a protected rule
    }
  }
  return null;
}

// ── Collect scanned files ─────────────────────────────────────────────────────
//
// The disable-ban covers:
//   - tests/**/*.test.cjs  — test sources (phase 1–4 scope)
//   - src/**/*.cts         — production TypeScript sources (extended in phase 5 to
//                            protect normalize-path-in-content, which applies to
//                            src/**/*.cts; an eslint-disable there would bypass the
//                            production rule entirely)
//   - bin/install.js + scripts/build-hooks.js — the ADR-1703 Phase 6 glob expansion
//                            surface (DEFECT.WINDOWS-FS-OPS); an eslint-disable in the
//                            generated installer or build-side atomic-replace helper
//                            would bypass require-fs-op-fallback / normalize-path-in-content

const SELF_ABS = __filename;

function collectTestFiles() {
  const root = path.join(__dirname, '..');
  const testFiles = globSync('tests/**/*.test.cjs', { cwd: root })
    .map(rel => path.join(root, rel))
    .filter(absPath => absPath !== SELF_ABS);
  const srcFiles = globSync('src/**/*.cts', { cwd: root })
    .map(rel => path.join(root, rel));
  // ADR-1703 Phase 6: the two production portability-rule surfaces outside src/ + tests/.
  const prodExtra = [
    path.join(root, 'bin', 'install.js'),
    path.join(root, 'scripts', 'build-hooks.js'),
  ].filter(absPath => fs.existsSync(absPath));
  return [...testFiles, ...srcFiles, ...prodExtra];
}

// ── Scan ──────────────────────────────────────────────────────────────────────

function scanFile(absPath) {
  let src;
  try {
    src = fs.readFileSync(absPath, 'utf-8');
  } catch (err) {
    throw new Error(`Could not read ${absPath}: ${err.message}`);
  }

  // bin/install.js (generated installer) starts with a `#!/usr/bin/env node` shebang
  // that espree cannot parse. Rewrite the leading `#!` to `//` so it becomes a valid
  // line comment — this preserves byte length and line numbers so any reported
  // directive stays at the correct source line.
  if (src.startsWith('#!')) src = '//' + src.slice(2);

  // .cts files use TypeScript syntax — use @typescript-eslint/typescript-estree.
  // .cjs files use plain JS — use espree (the original parser).
  const isCts = absPath.endsWith('.cts');

  let ast;
  try {
    if (isCts) {
      ast = tsEstree.parse(src, { comment: true, loc: true, range: true });
    } else {
      ast = espree.parse(src, {
        comment: true,
        ecmaVersion: 2022,
        loc: true,
        range: true,
        tolerant: true,
      });
    }
  } catch (parseErr) {
    // C5: fail CLOSED on parse error — a file that fails to parse must FAIL the
    // test with its path, not be silently skipped.  Silent skip is a false-green:
    // an unparseable test file could contain a real disable directive.
    throw new Error(`Parse error in ${absPath}: ${parseErr.message}`);
  }

  const blanket = [];
  const named = [];

  for (const cmt of ast.comments || []) {
    const kind = classifyComment(cmt.value);
    if (!kind) continue;
    const line = cmt.loc ? cmt.loc.start.line : '?';
    const entry = { file: absPath, line, text: cmt.value.trim() };
    if (kind === 'blanket') blanket.push(entry);
    else if (kind === 'named') named.push(entry);
  }

  return { blanket, named };
}

// ── C5: parse-error fail-closed ───────────────────────────────────────────────

describe('C5 — scanFile fails closed on parse error', () => {
  test('C5a: scanFile throws on parse error instead of silently returning empty result (.cjs path, espree)', () => {
    // Inject a parse error deterministically by monkeypatching espree.parse.
    // This is the cross-platform approach (works under root/Docker too).
    const origParse = espree.parse;
    try {
      espree.parse = () => { throw new SyntaxError('injected parse error for C5 test'); };
      // Create a minimal real file to scan (use this test file itself, which exists).
      assert.throws(
        () => scanFile(__filename),
        (err) => {
          return err instanceof Error &&
            err.message.includes('injected parse error for C5 test');
        },
        'scanFile must throw on parse error, not silently return empty result'
      );
    } finally {
      espree.parse = origParse;
    }
  });

  test('W1/C5b: scanFile throws on parse error for .cts path (tsEstree path — fail-closed)', () => {
    // W1: The existing C5a test only exercises the espree (.cjs) path.  This test
    // exercises the tsEstree (.cts) path by monkeypatching tsEstree.parse and
    // pointing scanFile at a synthetic .cts-suffixed path.
    //
    // Cross-platform approach: monkeypatch the module method, not chmod/permissions
    // (chmod 0o000 is bypassed by root in Docker and behaves differently per OS).
    //
    // tsEstree exports 'parse' via a configurable getter (no setter), so we use
    // Object.defineProperty to inject a throwing stub, then restore the original
    // descriptor in the finally block.
    const tsEstreeModule = require('@typescript-eslint/typescript-estree');
    const origDescriptor = Object.getOwnPropertyDescriptor(tsEstreeModule, 'parse');
    const injected = () => { throw new SyntaxError('injected tsEstree parse error for W1/C5b test'); };
    Object.defineProperty(tsEstreeModule, 'parse', {
      value: injected,
      writable: true,
      configurable: true,
      enumerable: true,
    });

    // Also monkeypatch fs.readFileSync to return dummy content for the fake .cts
    // path, so the .cts branch in scanFile runs without needing a real file.
    const origReadFileSync = fs.readFileSync;
    fs.readFileSync = (p, enc) => {
      if (typeof p === 'string' && p.endsWith('.cts')) return '// dummy cts content';
      return origReadFileSync.call(fs, p, enc);
    };

    try {
      assert.throws(
        () => scanFile(path.join(__dirname, 'dummy-fixture.cts')),
        (err) => {
          return err instanceof Error &&
            err.message.includes('injected tsEstree parse error for W1/C5b test');
        },
        'scanFile must throw on tsEstree parse error for .cts files (fail-closed)'
      );
    } finally {
      fs.readFileSync = origReadFileSync;
      // Restore original descriptor (getter-only)
      Object.defineProperty(tsEstreeModule, 'parse', origDescriptor);
    }
  });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('portability-rule disable-ban (ADR-1703)', () => {
  const testFiles = collectTestFiles();

  test('test file enumeration finds at least 10 test files', () => {
    assert.ok(
      testFiles.length >= 10,
      `Expected at least 10 test files, got ${testFiles.length}`,
    );
  });

  test('no test file contains a named eslint-disable for a portability rule (category a)', () => {
    const offenders = [];
    for (const absPath of testFiles) {
      const { named } = scanFile(absPath);
      for (const o of named) {
        offenders.push(`${path.relative(path.join(__dirname, '..'), o.file)}:${o.line} — ${o.text}`);
      }
    }
    assert.deepStrictEqual(
      offenders,
      [],
      'Found inline disable directives suppressing protected portability rules.\n' +
      'These MUST be removed — the rule exists to enforce cross-platform safety:\n\n' +
      offenders.map(s => '  ' + s).join('\n'),
    );
  });

  test('no test file contains a blanket eslint-disable (category b — suppresses all rules including portability)', () => {
    const offenders = [];
    for (const absPath of testFiles) {
      const { blanket } = scanFile(absPath);
      for (const o of blanket) {
        offenders.push(`${path.relative(path.join(__dirname, '..'), o.file)}:${o.line} — ${o.text}`);
      }
    }
    assert.deepStrictEqual(
      offenders,
      [],
      'Found blanket eslint-disable directives in test files.\n' +
      'Blanket disables suppress ALL rules including portability rules and are banned.\n' +
      'Replace with targeted per-rule disables for non-portability rules, or remove:\n\n' +
      offenders.map(s => '  ' + s).join('\n'),
    );
  });
});

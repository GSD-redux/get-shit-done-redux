// allow-test-rule: source-text-is-the-product #2547 — this invariant is a
// property of hook SOURCE TEXT. It cannot be written as a behavioural test; see
// "Why this is a source scan" below.
/**
 * Typed-payload-read invariant for the guard hooks (#2547, PR #2595 review
 * Major 3 + the sibling sweep it prompted).
 *
 * ## The defect class
 *
 * A guard reads a model-supplied path field out of the hook payload with a
 * `|| ''` default and hands it to an API that demands a string —
 * `path.isAbsolute()`, `String.prototype.includes()`, `String.prototype.replace()`.
 * `[]` and `{}` are TRUTHY, so they survive the `if (!filePath)` early-out and
 * throw one line later, landing in the script's outer `catch { process.exit(0) }`.
 * That is crash-to-allow: a should-block call is silently downgraded to an allow.
 *
 * The review found this at `gsd-worktree-path-guard.js`'s block read. Sweeping
 * the class rather than the instance found the same untyped shape at five more
 * read sites across four other hooks — advisory-only there, but the same one
 * line away from a blocking path, and at `gsd-prompt-guard.js` it silenced the
 * injection scan exactly as a shadowed `new_string` did.
 *
 * ## Why this is a source scan and not a behavioural test
 *
 * The fixed read and the crashing read are BLACK-BOX IDENTICAL. Both end at
 * `process.exit(0)`: the crash reaches it via the outer catch, the typed read
 * reaches it via `if (!filePath)` after the non-string collapses to `''`. Same
 * exit code, same empty stdout, same silent stderr. A test asserting
 * `status === 0` on a non-string payload therefore passes against the UNFIXED
 * code too — which is precisely the false-green the review objected to in the
 * `['non-string file_path (array)', []]` cases, and repeating it one level up
 * would be no better. The behavioural cases in tests/worktree-safety.test.cjs
 * document the fail-open; THIS file is what actually fails if the fix is
 * reverted.
 *
 * The repo already relies on this shape: tests/kimi-guard-normalization-parity
 * binds five inlined copies that nothing at runtime binds.
 *
 * ## Scope
 *
 * Deliberately the whole hooks/ directory, not the five #2304-normalized
 * guards. The class is "untyped read of a model-supplied path field", which has
 * nothing to do with Kimi normalization — `gsd-windsurf-pre-write.js` is not a
 * normalized guard and reads `tool_info.file_path`, already typed. A new hook
 * added later gets swept in automatically.
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const HOOKS_DIR = path.join(__dirname, '..', 'hooks');

// Reads of a model-supplied PATH field off the hook payload. Both container
// shapes are covered: `tool_input` (Claude Code / Kimi) and `tool_info`
// (Windsurf pre_write_code).
const PATH_FIELD_READ = /\b(?:tool_input|tool_info|toolInfo)\s*\??\.\s*(?:file_path|path)\b/;

// Floor: a scan that matches nothing is a BROKEN scan reporting green, not a
// clean repo. These files are known to read a path field off the payload.
const KNOWN_READERS = [
  'gsd-prompt-guard.js',
  'gsd-read-guard.js',
  'gsd-read-injection-scanner.js',
  'gsd-windsurf-pre-write.js',
  'gsd-workflow-guard.js',
  'gsd-worktree-path-guard.js',
];

/**
 * Strips line and block comments so prose ABOUT the defect (this PR adds
 * several such comments, quoting the old `|| ''` form verbatim) is not scanned
 * as though it were code.
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * Splits into statements. A typed read spans multiple LINES —
 *   const p = typeof d.tool_input?.file_path === 'string'
 *     ? d.tool_input.file_path
 *     : '';
 * — so a per-line rule would flag the continuation line, which carries the read
 * without its guard. The statement is the unit that either has a type test or
 * does not.
 */
function statements(src) {
  const out = [];
  let start = 0;
  const lineOf = (idx) => src.slice(0, idx).split('\n').length;
  const push = (from, to) => {
    const text = src.slice(from, to);
    const m = text.match(PATH_FIELD_READ);
    // Anchor the report on the READ, not on the statement start — a statement
    // begins right after the previous `;`, so its first line is usually the
    // preceding `}` and pointing there sends the reader to the wrong place.
    const offset = m ? m.index : 0;
    out.push({
      text,
      line: lineOf(from + offset),
      snippet: text.slice(offset).split('\n')[0].trim(),
    });
  };
  for (let i = 0; i < src.length; i++) {
    if (src[i] === ';') {
      push(start, i + 1);
      start = i + 1;
    }
  }
  push(start, src.length);
  return out;
}

const hookFiles = fs
  .readdirSync(HOOKS_DIR)
  .filter((f) => f.endsWith('.js'))
  .sort();

describe('guard hooks read model-supplied path fields TYPED (#2547 / #2595 Major 3)', () => {
  test('the scan finds every known path-field reader (floor)', () => {
    const readers = hookFiles.filter((f) =>
      PATH_FIELD_READ.test(stripComments(fs.readFileSync(path.join(HOOKS_DIR, f), 'utf8')))
    );
    for (const known of KNOWN_READERS) {
      assert.ok(
        readers.includes(known),
        `${known} no longer matches the path-field read pattern — either the read ` +
          'was removed or the scan regex broke; both mean this gate is silently ' +
          'covering less than it claims'
      );
    }
  });

  test('no hook reads a payload path field without a typeof string test', () => {
    const offenders = [];
    for (const file of hookFiles) {
      const src = stripComments(fs.readFileSync(path.join(HOOKS_DIR, file), 'utf8'));
      for (const stmt of statements(src)) {
        if (!PATH_FIELD_READ.test(stmt.text)) continue;
        if (/\btypeof\b/.test(stmt.text)) continue;
        offenders.push(`hooks/${file}:${stmt.line}  ${stmt.snippet.slice(0, 90)}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'Untyped read of a model-supplied path field. `[]` and `{}` are truthy, so ' +
        'they pass an `if (!value)` early-out and then throw inside ' +
        'path.isAbsolute() / .includes() / .replace(), reaching the outer ' +
        '`catch { process.exit(0) }` — crash-to-allow (#2547). Read it as ' +
        "`typeof x === 'string' ? x : ''`, as hooks/gsd-windsurf-pre-write.js " +
        'already does.\nOffenders:\n  ' + offenders.join('\n  ')
    );
  });
});

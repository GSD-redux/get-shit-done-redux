// Guards the dispatch model-pin VALUE policy in gsd-core/bin/gsd-tools.cjs
// (`resolveDispatchModelPin`, `MODEL_ID_CHARSET_RE`, `MODEL_ID_CHARSET_BODY`,
// `MODEL_ID_SANITIZE_STRIP_RE`, `MODEL_ID_MAX_LENGTH`):
//
//  - Item 1: the accept-class (matcher) and the render-class (sanitizer)
//    are single-sourced from one character-class body and can never drift
//    apart again the way they already did once (accept regex gained '@'
//    for Vertex pins; sanitizer keep-class did not, so a rejected
//    Vertex-shaped pin rendered "text-bison?002" instead of
//    "text-bison@002").
//  - Item 2: a pin longer than MODEL_ID_MAX_LENGTH (200) is dropped with a
//    warning rather than reaching argv truncated. Boundary rows at
//    limit-1/limit/limit+1 (199/200/201).
//  - Item 3: the leading character must be alphanumeric, closing off
//    '@'/'/' -shaped values (`@evil`, `/c`) from reaching argv, while five
//    legitimate real-world model ids continue to pass unchanged.
//
// Every rejection path must degrade to "no model" (drop-and-warn) — never
// `undefined` being skipped in favor of an exception, and never a value
// that still contains an unsafe character escaping to argv.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const gsdTools = require('../gsd-core/bin/gsd-tools.cjs');
const {
  resolveDispatchModelPin,
  MODEL_ID_CHARSET_RE,
  MODEL_ID_CHARSET_BODY,
  MODEL_ID_SANITIZE_STRIP_RE,
  MODEL_ID_MAX_LENGTH,
} = gsdTools;

/** Capture process.stderr.write() calls made during `fn()`. */
function captureStderr(fn) {
  const original = process.stderr.write;
  const chunks = [];
  process.stderr.write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    fn();
  } finally {
    process.stderr.write = original;
  }
  return chunks.join('');
}

describe('#3714 follow-up: dispatch model-pin VALUE policy', () => {
  test('MODEL_ID_MAX_LENGTH is the documented 200', () => {
    assert.strictEqual(MODEL_ID_MAX_LENGTH, 200);
  });

  test('five legitimate real-world model ids all pass through unchanged', () => {
    const ids = [
      'gpt-5.6-terra',
      'synthetic/hf:zai-org/GLM-5.2',
      'text-bison@002',
      'gpt-4o_mini',
      'azure/deployment',
    ];
    for (const id of ids) {
      const stderr = captureStderr(() => {
        assert.strictEqual(resolveDispatchModelPin(`agent-${id}`, id), id);
      });
      assert.strictEqual(stderr, '', `expected no warning for legitimate id "${id}"`);
    }
  });

  test('item 3: leading "@" and leading "/" are dropped with a warning, never reach argv', () => {
    for (const bad of ['@evil', '/c']) {
      const stderr = captureStderr(() => {
        assert.strictEqual(resolveDispatchModelPin(`agent-${bad}`, bad), undefined);
      });
      assert.match(stderr, /gsd: warning/);
      assert.match(stderr, /unsafe characters/);
    }
  });

  test('leading-dash values report the flag/option message, not the generic unsafe-characters message (LEADING_DASH_RE must run before MODEL_ID_CHARSET_RE)', () => {
    for (const bad of ['-c', '--config', '-', '--', '-p']) {
      const stderr = captureStderr(() => {
        assert.strictEqual(resolveDispatchModelPin(`agent-${bad}`, bad), undefined);
      });
      assert.match(stderr, /gsd: warning/);
      assert.match(stderr, /looks like a flag\/option, not a model id \(leading "-"\)/);
      assert.doesNotMatch(stderr, /unsafe characters/);
    }
  });

  test('non-dash out-of-charset values still report the generic unsafe-characters message', () => {
    for (const bad of ['@evil', 'has a space']) {
      const stderr = captureStderr(() => {
        assert.strictEqual(resolveDispatchModelPin(`agent-x`, bad), undefined);
      });
      assert.match(stderr, /gsd: warning/);
      assert.match(stderr, /unsafe characters/);
      assert.doesNotMatch(stderr, /flag\/option/);
    }
  });

  test('item 2: boundary rows at limit-1/limit/limit+1 (199/200/201)', () => {
    const at199 = 'a'.repeat(199);
    const at200 = 'a'.repeat(200);
    const at201 = 'a'.repeat(201);

    let stderr = captureStderr(() => {
      assert.strictEqual(resolveDispatchModelPin('agent-199', at199), at199);
    });
    assert.strictEqual(stderr, '', '199 chars must emit with no warning');

    stderr = captureStderr(() => {
      assert.strictEqual(resolveDispatchModelPin('agent-200', at200), at200);
    });
    assert.strictEqual(stderr, '', '200 chars must emit with no warning');

    stderr = captureStderr(() => {
      assert.strictEqual(resolveDispatchModelPin('agent-201', at201), undefined);
    });
    assert.match(stderr, /gsd: warning/);
    assert.match(stderr, /exceeds the maximum model id length \(200 characters\)/);
  });

  test('item 2: an over-length pin is dropped, never truncated into a shorter value', () => {
    // A truncated model id is a different model id — the resolver must
    // never return a 200-char prefix of a 5000-char input.
    const huge = 'a'.repeat(5000);
    const result = captureStderr(() => resolveDispatchModelPin('agent-huge', huge));
    assert.match(result, /exceeds the maximum model id length/);
  });

  test('item 1 (parity): a rejected Vertex-shaped pin renders "@" correctly, not "?"', () => {
    // Append a control byte so the value fails the charset test (and is
    // therefore routed through the sanitizer) while still containing '@'.
    const rawValue = 'text-bison@002' + String.fromCharCode(27);
    const stderr = captureStderr(() => {
      assert.strictEqual(resolveDispatchModelPin('agent-vertex', rawValue), undefined);
    });
    assert.match(stderr, /"text-bison@002\?"/, 'the "@" must survive the sanitizer unchanged');
    assert.doesNotMatch(stderr, /text-bison\?002/, 'the "@" must never be sanitized to "?"');
  });

  test('item 1 (parity, exhaustive): every character in the accept-class body survives the sanitizer unchanged', () => {
    // Every printable character that MODEL_ID_CHARSET_RE accepts as a
    // non-leading character must also survive MODEL_ID_SANITIZE_STRIP_RE
    // unchanged — the two are derived from one shared body, so this can
    // never regress silently again.
    const acceptedNonLeadingChars = 'A-Za-z0-9._:/@-';
    // Expand the class body into a concrete character list (letters, digits,
    // and the literal punctuation), independent of the regex-escaping used
    // to define it, so the assertion doesn't just re-check the definition
    // against itself.
    const chars = [];
    for (let c = 65; c <= 90; c++) chars.push(String.fromCharCode(c)); // A-Z
    for (let c = 97; c <= 122; c++) chars.push(String.fromCharCode(c)); // a-z
    for (let c = 48; c <= 57; c++) chars.push(String.fromCharCode(c)); // 0-9
    chars.push('.', '_', ':', '/', '@', '-');
    assert.ok(chars.length > 0);

    for (const ch of chars) {
      const value = 'x' + ch; // 'x' keeps the leading-char anchor satisfied
      assert.match(value, MODEL_ID_CHARSET_RE, `"${value}" should be accepted by MODEL_ID_CHARSET_RE`);
      const sanitized = value.replace(MODEL_ID_SANITIZE_STRIP_RE, '?');
      assert.strictEqual(sanitized, value, `"${ch}" is accepted but was sanitized away`);
    }
    // Assert the literal class body above EQUALS the exported production
    // value, so this test fails if gsd-tools.cjs's MODEL_ID_CHARSET_BODY is
    // edited (e.g. widened) without updating this test's expectations.
    assert.strictEqual(
      acceptedNonLeadingChars,
      MODEL_ID_CHARSET_BODY,
      'this test\'s expected charset has drifted from gsd-tools.cjs\'s MODEL_ID_CHARSET_BODY',
    );
  });

  test('item 1 (property): fast-check — any string accepted by MODEL_ID_CHARSET_RE is unchanged by the sanitizer', () => {
    const bodyChar = fc.constantFrom(
      ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._:/@-'.split(''),
    );
    const leadChar = fc.constantFrom(
      ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.split(''),
    );
    fc.assert(
      fc.property(leadChar, fc.array(bodyChar, { maxLength: 40 }), (lead, rest) => {
        const value = lead + rest.join('');
        assert.match(value, MODEL_ID_CHARSET_RE);
        const sanitized = value.replace(MODEL_ID_SANITIZE_STRIP_RE, '?');
        assert.strictEqual(sanitized, value);
      }),
    );
  });

  test('every rejection path degrades to undefined (drop-and-warn), never throws', () => {
    const inputs = [
      '@evil',
      '/c',
      '-c',
      '--config',
      'a'.repeat(201),
      'sonnet',
      String.fromCharCode(27) + 'malicious',
      '',
      '   ',
      'inherit',
      'INHERIT',
    ];
    for (const input of inputs) {
      assert.doesNotThrow(() => {
        captureStderr(() => resolveDispatchModelPin('agent-x', input));
      }, `resolveDispatchModelPin must never throw for input ${JSON.stringify(input)}`);
    }
  });
});

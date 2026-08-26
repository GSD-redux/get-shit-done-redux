'use strict';

/**
 * Structural serializer for the frontmatter golden-parity gate (ADR-3473 §8.1, #3881, row D2).
 *
 * The legacy line-scanner parser can return an Array carrying a NAMED own-enumerable
 * property alongside its indexed elements — e.g. `k:\n  - test: a\n    other: b` yields
 * an array whose `Object.keys()` is `["0","other"]` (index "0" holds `"test: a"`, and
 * `"other"` holds `"b"` as a non-index property). `JSON.stringify` silently drops any
 * non-index own property of an array, so a JSON-based golden would compare only the
 * `["test: a"]` shape and never notice `.other` — a parity gate that cannot see the exact
 * shape it exists to protect (#3427's failure mode, reproduced inside the gate meant to
 * prevent it: see D2 in tests/frontmatter-golden-parity.test.cjs).
 *
 * This serializer instead walks every own enumerable property (`Object.keys`, which
 * includes non-index array properties) and folds arrays into a `[items]{named}` form so
 * the named-property tail is always represented in the output string. Object keys are
 * sorted for determinism (property insertion order is not part of either parser's
 * documented contract). Symbol-keyed properties (e.g. the #3257 comment channel, the
 * unparseable marker) are deliberately excluded: Object.keys never returns them, so they
 * were already invisible to the legacy line-scanner's output shape this golden pins.
 */
function serializeFrontmatterValue(value) {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) {
    const items = value.map((item) => serializeFrontmatterValue(item));
    const namedKeys = Object.keys(value)
      .filter((k) => !/^\d+$/.test(k))
      .sort();
    let out = `[${items.join(',')}]`;
    if (namedKeys.length) {
      out += `{${namedKeys
        .map((k) => `${JSON.stringify(k)}:${serializeFrontmatterValue(value[k])}`)
        .join(',')}}`;
    }
    return out;
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${serializeFrontmatterValue(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

module.exports = { serializeFrontmatterValue };

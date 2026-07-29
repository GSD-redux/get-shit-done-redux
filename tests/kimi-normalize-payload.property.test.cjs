'use strict';

// allow-test-rule: source-text-is-the-product #2304 — normalizeKimiPayload is
// deliberately INLINED per hook script with no runtime binding (see the
// rationale comment in each guard and tests/kimi-guard-normalization-parity.test.cjs).
// There is nothing to require, so this test extracts the block from hook source
// and evaluates it, exactly as the parity test does.

/**
 * Property-based totality tests for normalizeKimiPayload (#2547, PR #2595
 * review MAJOR).
 *
 * PR #2595 claims the fix "makes normalization total over the inputs JSON can
 * express" — a for-all-inputs guarantee. The regression tests backing it are
 * example-based (hand-picked shapes added reactively after each crash was
 * manually found, including the String()-coercion trap, which was itself found
 * by adversarial review AFTER the first commit shipped). Example-based tests
 * cannot substantiate a for-all claim; they only record the counterexamples
 * someone happened to think of. This file is the generative complement, so the
 * NEXT counterexample fails here instead of waiting on the next reviewer.
 *
 * Properties:
 *   (a) TOTALITY — normalizeKimiPayload never throws for any JSON-expressible
 *       tool_input. This is the PR's own stated claim, tested directly.
 *   (b) TOTALITY over the edit list specifically — the crash surface both
 *       #2547 fixes targeted (nullish dereference, non-coercible String()).
 *   (c) AUTHORITATIVE PATH — whenever `path` is a string, `file_path` equals it
 *       afterwards, for every model-supplied `file_path` JSON can express.
 *       This is the review-BLOCKER invariant: a guard reading `file_path` can
 *       never be pointed at a file other than the one kimi-cli will write.
 *   (d) NON-KIMI PASSTHROUGH — a payload whose tool_name is not in the Kimi
 *       vocabulary is returned untouched, so the fix cannot alter the native
 *       Claude Code contract.
 *
 * `fc.anything()` covers exactly the JSON-expressible domain the claim names —
 * including the `{toString: null}` shape, arrays, nested objects, and the
 * nullish entries the two shipped fixes were written for.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const fc = require('./helpers/fast-check-setup.cjs');

// Extract the inlined block from hook source and bind it as a real function.
// Deliberately the SAME extraction contract the parity test uses (the
// `const KIMI_TOOL_NAMES` … `  return data;\n}` span), so a source edit that
// breaks one breaks both rather than leaving this file silently testing a stale
// or empty block.
const HOOK = path.join(__dirname, '..', 'hooks', 'gsd-worktree-path-guard.js');

function loadNormalizer() {
  const src = fs.readFileSync(HOOK, 'utf8');
  const start = src.indexOf('const KIMI_TOOL_NAMES');
  assert.notEqual(start, -1, 'KIMI_TOOL_NAMES block not found in hook source');
  const endMarker = '  return data;\n}';
  const end = src.indexOf(endMarker, start);
  assert.notEqual(end, -1, 'normalizeKimiPayload end not found in hook source');
  const block = src.slice(start, end + endMarker.length);
  const ctx = { module: { exports: {} } };
  vm.createContext(ctx);
  vm.runInContext(`${block}\nmodule.exports = { normalizeKimiPayload, KIMI_TOOL_NAMES };`, ctx);
  return ctx.module.exports;
}

const { normalizeKimiPayload, KIMI_TOOL_NAMES } = loadNormalizer();

// Floor: an extraction that yielded nothing usable must FAIL, not silently pass
// four properties over a no-op. Without this, a broken `extractBlock` reports
// green forever.
describe('normalizeKimiPayload — extraction floor', () => {
  test('the extracted block exposes a working normalizer and a non-empty map', () => {
    assert.strictEqual(typeof normalizeKimiPayload, 'function');
    assert.ok(KIMI_TOOL_NAMES.size > 0, 'KIMI_TOOL_NAMES extracted empty');
    assert.ok(KIMI_TOOL_NAMES.has('StrReplaceFile'), 'StrReplaceFile missing from extracted map');
    // Sanity: the extracted function actually normalizes, so the properties
    // below are exercising real behaviour rather than an early return.
    const out = normalizeKimiPayload({ tool_name: 'StrReplaceFile', tool_input: { path: '/a/b.ts' } });
    assert.strictEqual(out.tool_name, 'Edit');
    assert.strictEqual(out.tool_input.file_path, '/a/b.ts');
  });
});

// Any Kimi tool name, including the module-path-prefixed form kimi-cli actually
// emits (`kimi_cli.tools.file.replace:StrReplaceFile`) — the guards strip
// everything up to the last ':'.
const kimiToolName = fc.oneof(
  fc.constantFrom(...KIMI_TOOL_NAMES.keys()),
  fc.constantFrom(...KIMI_TOOL_NAMES.keys()).map((n) => `kimi_cli.tools.file.replace:${n}`)
);

describe('normalizeKimiPayload — properties', () => {
  // A bare fc.anything() for tool_input is NEARLY VACUOUS as a crash-finder: the
  // crash surface lives behind the `edit` key, and arbitrary generation
  // essentially never invents that key (verified — a bare-anything version of
  // this property passed against pristine pre-#2547 `next`, where the defect was
  // live). So the generator is biased onto the keys normalization actually
  // reads, each drawn from the full JSON domain, and unioned with genuinely
  // arbitrary input so the unbiased space is still covered.
  // #2595 (review Major 1): the bias above stopped one level too high. The
  // ENTRIES of the edit array were bare fc.anything(), which essentially never
  // invents an `old`/`new` key — so `e?.old` was always undefined, and
  // `String(undefined ?? '')` never coerced anything. Reverting editText to the
  // unguarded `String(v ?? '')` therefore left every property green: the
  // coercion mutant this file was added to kill SURVIVED it.
  //
  // Biasing the entry onto {old, new} is necessary but NOT sufficient, and this
  // is the part worth stating: measured over 20,000 draws, bare fc.anything()
  // yields a NON-COERCIBLE value 3 times — 0.015%. At numRuns:200, an `old` key
  // holding a hostile value essentially never co-occurs, so the mutant survives
  // the entry bias too (verified against all four mutants). Both levels have to
  // be biased: the entry onto the keys normalization reads, and the VALUE onto
  // the shape that actually throws.
  //
  // `{"toString": <non-function>}` is that shape, and it is squarely inside the
  // "JSON-expressible" domain this file's claim names — JSON.parse produces it
  // verbatim, and it is the exact class adversarial review found after the
  // first #2547 commit shipped. Union it in rather than reaching for
  // fc.anything({withNullPrototype:true}), whose null-prototype objects JSON
  // cannot express and so would widen the claim past what the PR asserts.
  const jsonNonCoercible = fc.record(
    {
      toString: fc.oneof(fc.constant(null), fc.integer(), fc.string(), fc.boolean()),
      valueOf: fc.oneof(fc.constant(null), fc.integer()),
    },
    { requiredKeys: ['toString'] }
  );
  const editValue = fc.oneof(fc.anything(), jsonNonCoercible);
  const editEntry = fc.oneof(
    fc.anything(),
    fc.record({ old: editValue, new: editValue }, { requiredKeys: [] })
  );
  const editList = fc.oneof(fc.anything(), fc.array(editEntry));

  const guardRelevantInput = fc.oneof(
    fc.anything(),
    fc.record(
      {
        path: fc.anything(),
        file_path: fc.anything(),
        edit: editList,
        old_string: fc.anything(),
        new_string: fc.anything(),
      },
      { requiredKeys: [] }
    )
  );

  test('(a) is total over every JSON-expressible tool_input', () => {
    fc.assert(
      fc.property(kimiToolName, guardRelevantInput, (toolName, toolInput) => {
        assert.doesNotThrow(() =>
          normalizeKimiPayload({ tool_name: toolName, tool_input: toolInput })
        );
      })
    );
  });

  test('(b) is total over every JSON-expressible edit list', () => {
    fc.assert(
      fc.property(
        kimiToolName,
        editList,
        fc.anything(),
        (toolName, edit, extra) => {
          assert.doesNotThrow(() =>
            normalizeKimiPayload({
              tool_name: toolName,
              tool_input: { path: '/repo/src/index.ts', edit, other: extra },
            })
          );
        }
      )
    );
  });

  test("(c) Kimi's `path` always wins over any model-supplied `file_path`", () => {
    fc.assert(
      fc.property(
        kimiToolName,
        fc.string(),      // the authoritative path kimi-cli will execute on
        fc.anything(),    // whatever file_path the model chose to inject
        (toolName, authoritativePath, injectedFilePath) => {
          const out = normalizeKimiPayload({
            tool_name: toolName,
            tool_input: { path: authoritativePath, file_path: injectedFilePath },
          });
          assert.strictEqual(
            out.tool_input.file_path,
            authoritativePath,
            'a model-supplied file_path must never survive alongside a string `path` — ' +
              'every guard reads file_path, and kimi-cli writes to path'
          );
        }
      )
    );
  });

  // #2595 (review nit): three surfaces the first version of this file never
  // reached — the PostToolUse field mapping, the empty edit list, and a payload
  // that is not an object at all.
  test('(e) is total over ANY JSON value as the whole payload, not just tool_input', () => {
    fc.assert(
      fc.property(fc.anything(), (payload) => {
        assert.doesNotThrow(() => normalizeKimiPayload(payload));
      })
    );
  });

  test('(f) tool_output is mapped to tool_response, and never clobbers an existing one', () => {
    fc.assert(
      // `existing` must be DEFINED: the mapping's condition is
      // `tool_response === undefined`, and an explicit `tool_response: undefined`
      // is indistinguishable from an absent key — so mapping over it is correct,
      // not a clobber. fc.anything() does generate undefined, and the first run
      // of this property duly found it.
      fc.property(kimiToolName, fc.anything(), fc.anything().filter((v) => v !== undefined),
        (toolName, out, existing) => {
        const mapped = normalizeKimiPayload({ tool_name: toolName, tool_output: out });
        assert.deepEqual(mapped.tool_response, out,
          'PostToolUse consumers read tool_response; kimi-cli emits tool_output');

        // An already-present tool_response wins — the mapping fills a gap, it
        // does not overwrite. (Unlike the tool_input fields, tool_response is a
        // top-level payload field the hook bus supplies, not a key the model
        // controls, so the authoritative-overwrite argument does not apply.)
        const both = normalizeKimiPayload({
          tool_name: toolName, tool_output: out, tool_response: existing,
        });
        assert.deepEqual(both.tool_response, existing);
      })
    );
  });

  test('(g) an empty edit list reconstructs nothing', () => {
    fc.assert(
      fc.property(kimiToolName, fc.string(), (toolName, p) => {
        const out = normalizeKimiPayload({
          tool_name: toolName, tool_input: { path: p, edit: [] },
        });
        // `edits.length` is 0, so the reconstruction block never runs and the
        // fields stay absent rather than becoming ''. A guard reading
        // new_string must see "no content supplied", not "empty content".
        assert.strictEqual(out.tool_input.old_string, undefined);
        assert.strictEqual(out.tool_input.new_string, undefined);
      })
    );
  });

  test('(d) a non-Kimi tool_name is passed through untouched', () => {
    fc.assert(
      fc.property(
        fc.string().filter((s) => !KIMI_TOOL_NAMES.has(s.slice(s.lastIndexOf(':') + 1))),
        fc.string(),
        (toolName, filePath) => {
          const input = { file_path: filePath };
          const out = normalizeKimiPayload({ tool_name: toolName, tool_input: input });
          assert.strictEqual(out.tool_name, toolName, 'non-Kimi tool_name must not be remapped');
          assert.strictEqual(
            out.tool_input.file_path,
            filePath,
            'the native Claude Code contract (file_path governs) must be unchanged'
          );
        }
      )
    );
  });
});

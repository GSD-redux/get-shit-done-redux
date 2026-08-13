// allow-test-rule: source-text-is-the-product (see #3025)
// sync-skills.md is a shipped workflow whose deployed text IS what the runtime
// loads — asserting its content tests the deployed contract (per CONTRIBUTING's
// source-text-is-the-product exemption; not a compiled-.cjs source-grep).

/**
 * #3025 — sync-skills must refuse cross-runtime sync.
 *
 * Skill content/layout is runtime-specific (the installer applies per-runtime
 * converters, adapter headers, brand swaps, layout rules), and `grok`/`gemini`
 * resolve to ANOTHER runtime's skills root. A verbatim `cp -r` from one runtime
 * corrupts every other destination and can damage a runtime the user never named.
 *
 * Chosen fix (user decision, 2026-08-13): option (b) — refuse unsafe (cross-
 * runtime) destinations with an actionable installer pointer; keep identity sync
 * as a no-op. See gsd-core/workflows/sync-skills.md Step 1 guard.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOW = path.join(__dirname, '..', 'gsd-core', 'workflows', 'sync-skills.md');

function readWorkflow() {
  return fs.readFileSync(WORKFLOW, 'utf8');
}

describe('#3025: sync-skills refuses cross-runtime skill sync', () => {
  const text = readWorkflow();

  test('Step 1 has a functional guard that exits non-zero for any cross-runtime destination', () => {
    // The guard must compare each destination to the source runtime and exit 1 on mismatch.
    assert.match(text, /!=\s+"\$FROM_RUNTIME"/, 'guard must compare each destination != FROM_RUNTIME');
    // The exit 1 must be INSIDE the guard loop, not one of the unrelated exit 1s in
    // Steps 2/3/5 — otherwise a mutant that drops only the guard's exit survives.
    const loopStart = text.indexOf('for DEST in "${TO_RUNTIMES[@]}"');
    const loopEnd = text.indexOf('done', loopStart);
    assert.notEqual(loopStart, -1, 'guard loop must exist');
    assert.ok(loopEnd > loopStart, 'guard loop must close');
    assert.ok(
      /exit 1/.test(text.slice(loopStart, loopEnd)),
      'the guard loop itself must exit non-zero (not an unrelated exit 1 elsewhere)',
    );
  });

  test('the refusal points the user at the installer (actionable, not a bare rejection)', () => {
    // Hyrum's Law: the narrowed vocabulary is a visible contract change; the error must
    // hand the user a command that produces correctly converted skills. The pointer is
    // generic (`--<runtime>`, not `--$DEST`) because grok/gemini have no dedicated flag.
    assert.match(text, /cross-runtime skill sync is not supported/, 'names the unsupported operation');
    assert.match(text, /npx -y @opengsd\/gsd-core@latest --global --<runtime>/, 'prints the installer command');
    assert.match(text, /\$DEST/, 'names the refused destination runtime');
    assert.match(text, /grok and gemini have no dedicated installer flag/, 'accurately notes grok/gemini aliasing rather than printing a wrong --grok/--gemini flag');
  });

  test('the guard runs BEFORE Step 5\'s verbatim cp -r copy (cross-runtime can never reach the copy)', () => {
    const guardIdx = text.indexOf('!= "$FROM_RUNTIME"');
    const copyIdx = text.indexOf('cp -r "$SRC_SKILLS_ROOT/$SKILL"');
    assert.notEqual(guardIdx, -1, 'guard must exist');
    assert.notEqual(copyIdx, -1, 'Step 5 copy loop must exist');
    assert.ok(
      guardIdx < copyIdx,
      `guard (idx ${guardIdx}) must precede the cp -r copy (idx ${copyIdx}) so a cross-runtime destination is refused before any filesystem write`,
    );
  });

  test('--to all is cross-runtime by definition when --from is set, so it is refused too', () => {
    // The guard iterates TO_RUNTIMES; `all` expands to runtimes that include some != FROM_RUNTIME.
    assert.match(text, /for DEST in "\$\{TO_RUNTIMES\[@\]\}"/, 'guard iterates the destination set');
    assert.match(text, /--to all/, 'the all expansion is still part of the interface');
  });

  test('identity sync (--from == --to) remains a supported no-op and is NOT refused', () => {
    // The guard condition is `!=`, so identity passes; the pre-existing no-op contract stays.
    const noOpIdx = text.indexOf('[no-op: source and destination are the same runtime]');
    assert.notEqual(noOpIdx, -1, 'identity no-op message must remain');
    assert.match(text, /If .--from. == .--to./, 'identity handling retained in validation');
  });

  test('#3025 security: --from/--to are shape-validated before any interpolation (no command-substitution injection)', () => {
    // A hostile value like --to '$(cmd)' must be rejected as not-a-runtime-id before it
    // reaches an echo/heredoc/[[ ]], where unquoted interpolation would execute it.
    assert.match(text, /is_runtime_id\(\)/, 'a runtime-id shape predicate must exist');
    assert.match(text, /\^\[a-z0-9\]\[a-z0-9-\]\*\$/, 'predicate must require lowercase-alphanumeric shape');
    const shapeIdx = text.indexOf('is_runtime_id()');
    // Shape validation must run BEFORE the cross-runtime refuse guard and before Step 2.
    const xruntimeIdx = text.indexOf('#3025: refuse cross-runtime skill sync');
    assert.ok(shapeIdx !== -1 && xruntimeIdx !== -1 && shapeIdx < xruntimeIdx, 'shape validation must precede the cross-runtime guard');
  });
});

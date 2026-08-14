// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.
'use strict';


/**
 * Next Up /clear Order Tests (#1623)
 *
 * Validates that /clear always appears BEFORE the command in Next Up blocks,
 * not as a <sub> footnote after the command. Users should see /clear first
 * so they run it before copy-pasting the actual command.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const GSD_ROOT = path.join(__dirname, '..', 'gsd-core');
const UI_BRAND = path.join(GSD_ROOT, 'references', 'ui-brand.md');
const CONTINUATION_FORMAT = path.join(GSD_ROOT, 'references', 'continuation-format.md');
const WORKFLOWS_DIR = path.join(GSD_ROOT, 'workflows');

/**
 * Recursively collect all .md files in a directory.
 */
function collectMarkdownFiles(dir) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMarkdownFiles(full));
    } else if (entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

describe('ui-brand.md — Next Up template has /clear before command', () => {
  const content = fs.readFileSync(UI_BRAND, 'utf-8');

  test('Next Up block template does not use <sub>/clear pattern', () => {
    const subClearPattern = /<sub>[^<]*\/clear[^<]*<\/sub>/gi;
    const matches = content.match(subClearPattern);
    assert.strictEqual(
      matches,
      null,
      'ui-brand.md must not contain <sub>/clear</sub> pattern — /clear should appear before the command'
    );
  });

  test('Next Up block template shows /clear then: before {copy-paste command}', () => {
    // Extract the Next Up Block section
    const nextUpSection = content.slice(
      content.indexOf('## Next Up Block'),
      content.indexOf('## Error Box')
    );
    assert.ok(nextUpSection.length > 0, 'Should find Next Up Block section');

    const clearIndex = nextUpSection.indexOf('/clear');
    const commandIndex = nextUpSection.indexOf('{copy-paste command}');
    assert.ok(clearIndex > -1, 'Should contain /clear');
    assert.ok(commandIndex > -1, 'Should contain {copy-paste command}');
    assert.ok(
      clearIndex < commandIndex,
      `/clear (at ${clearIndex}) must appear before {copy-paste command} (at ${commandIndex})`
    );
  });
});

describe('continuation-format.md — Next Up examples have /clear before commands', () => {
  const content = fs.readFileSync(CONTINUATION_FORMAT, 'utf-8');

  test('no <sub>/clear patterns remain', () => {
    const subClearPattern = /<sub>[^<]*\/clear[^<]*<\/sub>/gi;
    const matches = content.match(subClearPattern);
    assert.strictEqual(
      matches,
      null,
      'continuation-format.md must not contain <sub>/clear</sub> pattern'
    );
  });
});

describe('workflow files — no <sub>/clear patterns in Next Up blocks', () => {
  const workflowFiles = collectMarkdownFiles(WORKFLOWS_DIR);

  test('found workflow .md files to scan', () => {
    assert.ok(
      workflowFiles.length > 0,
      `Expected workflow .md files in ${WORKFLOWS_DIR}`
    );
  });

  test('no workflow file contains <sub> with /clear', () => {
    const subClearPattern = /<sub>[^<]*\/clear[^<]*<\/sub>/gi;
    const failures = [];

    for (const filePath of workflowFiles) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const matches = content.match(subClearPattern);
      if (matches) {
        failures.push({
          file: path.relative(GSD_ROOT, filePath),
          matches: matches.length,
          examples: matches.slice(0, 3),
        });
      }
    }

    assert.strictEqual(
      failures.length,
      0,
      `Found <sub>/clear</sub> pattern in ${failures.length} workflow file(s):\n` +
        failures
          .map(
            (f) =>
              `  ${f.file}: ${f.matches} match(es) — e.g. ${f.examples[0]}`
          )
          .join('\n')
    );
  });
});

describe('reference files — no <sub>/clear patterns', () => {
  const referencesDir = path.join(GSD_ROOT, 'references');
  const refFiles = collectMarkdownFiles(referencesDir);

  test('found reference .md files to scan', () => {
    assert.ok(
      refFiles.length > 0,
      `Expected reference .md files in ${referencesDir}`
    );
  });

  test('no reference file contains <sub> with /clear', () => {
    const subClearPattern = /<sub>[^<]*\/clear[^<]*<\/sub>/gi;
    const failures = [];

    for (const filePath of refFiles) {
      const content = fs.readFileSync(filePath, 'utf-8');
      const matches = content.match(subClearPattern);
      if (matches) {
        failures.push({
          file: path.relative(GSD_ROOT, filePath),
          matches: matches.length,
          examples: matches.slice(0, 3),
        });
      }
    }

    assert.strictEqual(
      failures.length,
      0,
      `Found <sub>/clear</sub> pattern in ${failures.length} reference file(s):\n` +
        failures
          .map(
            (f) =>
              `  ${f.file}: ${f.matches} match(es) — e.g. ${f.examples[0]}`
          )
          .join('\n')
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3083-resume-route-clear.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3083-resume-route-clear (consolidation epic #1969 B4 #1973)", () => {
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('bug #3083: resume-project next-step routing should not include /clear then:', () => {
  test('route_to_workflow block omits /clear then: in resume templates', () => {
    const workflowPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'resume-project.md');
    const content = fs.readFileSync(workflowPath, 'utf-8');
    const routeStart = content.indexOf('<step name="route_to_workflow">');
    const routeEnd = content.indexOf('</step>', routeStart);
    const routeBlock = content.slice(routeStart, routeEnd);

    assert.equal(routeBlock.includes('/clear` then:'), false, 'resume route templates must not include `/clear` then:');
  });

  test('route_to_workflow block includes exception note explaining resume behavior', () => {
    const workflowPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'resume-project.md');
    const content = fs.readFileSync(workflowPath, 'utf-8');
    const routeStart = content.indexOf('<step name="route_to_workflow">');
    const routeEnd = content.indexOf('</step>', routeStart);
    const routeBlock = content.slice(routeStart, routeEnd);

    assert.match(routeBlock, /resume.*exception|exception.*resume/i);
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// #3297: plan-phase --gaps Next Up must project --gaps-only onto execute-phase
// ────────────────────────────────────────────────────────────────────────

describe('bug #3297: --gaps planning mode projects --gaps-only onto the Next Up execute command', () => {
  const WORKFLOW = path.join(WORKFLOWS_DIR, 'plan-phase.md');

  function offerNextBlock(content) {
    // Anchor on the line-start tag: the prose reference `` `<offer_next>` ``
    // ("Route to <offer_next>") earlier in the file would otherwise match a
    // bare indexOf('<offer_next>') first.
    const start = content.indexOf('\n<offer_next>');
    const end = content.indexOf('\n</offer_next>', start);
    assert.notStrictEqual(start, -1, 'plan-phase.md must have an <offer_next> block at line start');
    assert.notStrictEqual(end, -1, 'plan-phase.md <offer_next> must close at line start');
    return content.slice(start, end);
  }

  const content = fs.readFileSync(WORKFLOW, 'utf-8');
  const offerNext = offerNextBlock(content);

  test('preamble captures --gaps planning mode into a persistent variable', () => {
    // Precondition for any conditional render: the gap mode must survive from
    // argument parsing to the completion screen. The file already captures
    // --reviews / --chunked / --research-phase this way; --gaps must too.
    assert.match(
      content,
      /GAPS_MODE=false[\s\S]*\$ARGUMENTS[\s\S]{0,80}?--gaps[\s\S]{0,40}?GAPS_MODE=true/,
      'plan-phase.md preamble must set GAPS_MODE from $ARGUMENTS --gaps (so the mode reaches <offer_next>)'
    );
  });

  test('preamble derives the execute-side --gaps-only flag (not the plan-side --gaps)', () => {
    // The handoff must point at execute-phase's scope flag, which is --gaps-only
    // (execute-phase.md:72/339/1426), NOT the plan-side --gaps. Asserting the
    // literal guards against a copy-the-wrong-flag regression.
    assert.match(
      content,
      /GAPS_EXEC_FLAG=""[\s\S]*GAPS_MODE[\s\S]{0,60}?GAPS_EXEC_FLAG="--gaps-only"/,
      'plan-phase.md preamble must derive GAPS_EXEC_FLAG="--gaps-only" from GAPS_MODE'
    );
  });

  test('the --gaps-only derivation is gated on GAPS_MODE alone (reviews mode unaffected)', () => {
    // Acceptance: a --reviews planning run's Next Up is unchanged. The execute
    // flag must be derived ONLY from --gaps, never from --reviews. Assert the
    // derivation statement references GAPS_MODE and does NOT reference reviews.
    const derivMatch = content.match(/GAPS_EXEC_FLAG=""[\s\S]{0,200}?GAPS_EXEC_FLAG="--gaps-only"/);
    assert.ok(derivMatch, 'expected a GAPS_EXEC_FLAG derivation block');
    const deriv = derivMatch[0];
    assert.match(deriv, /GAPS_MODE/, 'derivation must be gated on GAPS_MODE');
    assert.doesNotMatch(
      deriv,
      /reviews/i,
      'derivation must not reference --reviews — reviews-mode Next Up stays unchanged'
    );
  });

  test('Next Up execute command substitutes the projected flag (${GAPS_EXEC_FLAG})', () => {
    // The headline fix: the command line carries the flag placeholder so it
    // renders --gaps-only in gap mode and the bare command otherwise.
    assert.ok(
      /\/gsd:execute-phase\s+\{X\}\s+\$\{GAPS_EXEC_FLAG\}/.test(offerNext),
      '<offer_next> execute-phase command must substitute ${GAPS_EXEC_FLAG} after {X}. Got:\n' +
      offerNext.split('\n').filter((l) => /execute-phase/.test(l)).join('\n')
    );
  });

  test('Next Up still renders the bare command for standard runs (plain path unchanged)', () => {
    // Acceptance: a standard (non-gap) run's Next Up is unchanged. The var is
    // empty in the standard path, so the rendered command is byte-identical to
    // today. Asserting the command still begins /gsd:execute-phase {X} (the bare
    // form) and still carries ${GSD_WS} — the standard shape is preserved.
    assert.match(
      offerNext,
      /\/gsd:execute-phase\s+\{X\}\s+\$\{GAPS_EXEC_FLAG\}\s+\$\{GSD_WS\}/,
      '<offer_next> command must keep the bare /gsd:execute-phase {X} form with ${GSD_WS}'
    );
  });

  test('Next Up block documents the --gaps-only projection (literal reaches the handoff)', () => {
    // The gap-scoped flag literal must appear inside <offer_next> (via the
    // rendering note that explains what ${GAPS_EXEC_FLAG} expands to), so a
    // reader of the handoff sees the intended gap-closure scope.
    assert.ok(
      offerNext.includes('--gaps-only'),
      '<offer_next> must reference the --gaps-only execute-phase scope (the literal must reach the handoff)'
    );
  });
});

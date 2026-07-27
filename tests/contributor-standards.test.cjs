// allow-test-rule: source-text-is-the-product
// docs/contributor-standards.md is a contributor-facing contract doc — its headings
// and cross-links ARE what contributors read. Structural assertions on headings and
// links test the deployed contract, not implementation detail.

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const STANDARDS_DOC = path.join(REPO_ROOT, 'docs', 'contributor-standards.md');
const CONTRIBUTING_MD = path.join(REPO_ROOT, 'CONTRIBUTING.md');

function readStandardsDoc() {
  try {
    return fs.readFileSync(STANDARDS_DOC, 'utf-8');
  } catch (err) {
    assert.fail(`docs/contributor-standards.md does not exist: ${err.message}`);
  }
}

function parseH2Headings(content) {
  return content
    .split('\n')
    .filter((line) => /^## /.test(line))
    .map((line) => line.replace(/^## /, '').trim());
}

describe('docs/contributor-standards.md', () => {
  test('file exists', () => {
    assert.ok(fs.existsSync(STANDARDS_DOC), 'docs/contributor-standards.md must exist');
  });

  test('has required CONTEXT.md section', () => {
    const content = readStandardsDoc();
    const headings = parseH2Headings(content);
    const hasContextSection = headings.some((h) => /context/i.test(h));
    assert.ok(
      hasContextSection,
      `Expected an ## heading containing "context" (case-insensitive). Found headings: ${JSON.stringify(headings)}`
    );
  });

  test('has required ADR section', () => {
    const content = readStandardsDoc();
    const headings = parseH2Headings(content);
    const hasAdrSection = headings.some((h) => /adr/i.test(h));
    assert.ok(
      hasAdrSection,
      `Expected an ## heading containing "ADR" (case-insensitive). Found headings: ${JSON.stringify(headings)}`
    );
  });

  test('has required AI-agent section', () => {
    const content = readStandardsDoc();
    const headings = parseH2Headings(content);
    const hasAgentSection = headings.some((h) => /ai.?agent|agent.?assist/i.test(h));
    assert.ok(
      hasAgentSection,
      `Expected an ## heading containing "AI-agent" or "agent-assist" (case-insensitive). Found headings: ${JSON.stringify(headings)}`
    );
  });

  test('references CONTEXT.md', () => {
    const content = readStandardsDoc();
    assert.ok(
      content.includes('CONTEXT.md'),
      'docs/contributor-standards.md must reference CONTEXT.md'
    );
  });

  test('references docs/adr/', () => {
    const content = readStandardsDoc();
    assert.ok(
      content.includes('docs/adr/'),
      'docs/contributor-standards.md must reference docs/adr/'
    );
  });
});

/**
 * Parity: docs/contributor-standards.md tells contributors which CONTEXT.md sections to
 * write into. If it names a heading CONTEXT.md does not have, the instruction is
 * unfollowable — and that is not hypothetical: on 2026-07-27 it named `## Domain terms`
 * and `## AI Ops Memory`, neither of which has ever existed (#2721). Two surfaces, one
 * truth; this asserts they cannot diverge again.
 */
const CONTEXT_MD = path.join(REPO_ROOT, 'CONTEXT.md');

/**
 * The body of one `## ` section, exclusive of the next `## `. Split on /\r?\n/ so a CRLF
 * checkout parses identically. Shared by every assertion below — two copies of the same
 * section parser is exactly the silent divergence RULESET.SHARED-HELPERS-LINT-VS-TEST warns of.
 */
function sectionBody(content, heading) {
  const lines = content.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === heading);
  if (start === -1) return null;
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^##\s/.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/**
 * Backticked heading references that the standards doc attributes to CONTEXT.md.
 *
 * Scoped to the doc's own `## CONTEXT.md` section on purpose. The doc also names headings
 * belonging to *other* documents — `## Decision` and `## Consequences` describe an ADR
 * body, `## Standards followed` describes an issue/PR body. Extracting doc-wide would
 * demand CONTEXT.md grow headings that have nothing to do with it.
 *
 * `<Placeholder>` templates like `### <Module Name>` are skipped: they are shapes to
 * follow, not headings to find.
 */
function extractContextHeadingRefs(standardsContent) {
  const scope = sectionBody(standardsContent, '## CONTEXT.md');
  if (scope === null) return [];
  const refs = new Set();
  for (const m of scope.matchAll(/`(#{2,6}\s+[^`]+)`/g)) {
    const heading = m[1].trim();
    if (heading.includes('<')) continue;
    refs.add(heading);
  }
  return [...refs];
}

/** Headings actually present in CONTEXT.md. Anchored /m — CRLF-safe without a `\n` split. */
function actualHeadings(contextContent) {
  return new Set([...contextContent.matchAll(/^#{2,6}\s+.*$/gm)].map((m) => m[0].trim()));
}

describe('docs/contributor-standards.md ↔ CONTEXT.md heading parity', () => {
  test('everyContextHeadingNamedByTheStandardsDocExistsInContextMd', () => {
    const refs = extractContextHeadingRefs(readStandardsDoc());
    const actual = actualHeadings(fs.readFileSync(CONTEXT_MD, 'utf-8'));

    assert.ok(refs.length > 0, 'the standards doc must name at least one CONTEXT.md heading');
    const missing = refs.filter((r) => !actual.has(r));
    assert.deepEqual(
      missing,
      [],
      `docs/contributor-standards.md directs contributors to heading(s) that do not exist in ` +
        `CONTEXT.md: ${JSON.stringify(missing)}. Fix the standards doc (or add the heading).`
    );
  });

  test('contextMdStillHasTheGlossaryHeadingTheStandardsDocNamed', () => {
    const actual = actualHeadings(fs.readFileSync(CONTEXT_MD, 'utf-8'));
    assert.ok(
      actual.has('## Glossary — Domain modules and seams'),
      'the glossary heading is the one the standards doc points Module authors at'
    );
  });

  // Negative space for the extractor itself. The RED run of this suite flagged
  // `## Decision`, `## Consequences` and `## Standards followed` — all headings the doc
  // attributes to an ADR body or a PR body, not to CONTEXT.md. A doc-wide extractor would
  // demand CONTEXT.md sprout headings that do not belong to it.
  test('doesNotTreatAdrOrPrBodyHeadingsAsContextMdClaims', () => {
    const refs = extractContextHeadingRefs(readStandardsDoc());
    for (const foreign of ['## Decision', '## Consequences', '## Standards followed']) {
      assert.ok(
        !refs.includes(foreign),
        `${foreign} describes another document's structure and must not be read as a CONTEXT.md claim`
      );
    }
  });

  test('matchesAHeadingReferenceRegardlessOfLineEndingStyle', () => {
    const crlf = '## Test rules and lint\r\n\r\n### Emitted Artifact Provenance\r\n';
    const found = actualHeadings(crlf);
    assert.ok(found.has('## Test rules and lint'), 'a CRLF checkout must not defeat the match');
    assert.ok(found.has('### Emitted Artifact Provenance'));
  });
});

/**
 * The Emitted Artifact Provenance naming deliverable (#2721). Without these, the artifact
 * family that half the open PR queue collides on still has no name a contributor can look
 * up — which ADR-2719 identifies as a direct cause of the problem.
 */
describe('CONTEXT.md names the emitted-artifact family', () => {
  test('emittedAttributionRulesetIsUnderTheTestRulesAndLintSection', () => {
    const body = sectionBody(fs.readFileSync(CONTEXT_MD, 'utf-8'), '## Test rules and lint');
    assert.ok(body, 'CONTEXT.md must have a `## Test rules and lint` section');
    assert.ok(
      body.includes('RULESET.EMITTED_ATTRIBUTION='),
      'RULESET.EMITTED_ATTRIBUTION must be a sibling of the other test rules, not floating elsewhere'
    );
  });

  test('emittedArtifactProvenanceIsRegisteredInTheGlossary', () => {
    const body = sectionBody(
      fs.readFileSync(CONTEXT_MD, 'utf-8'),
      '## Glossary — Domain modules and seams'
    );
    assert.ok(body, 'CONTEXT.md must have the glossary section');
    assert.ok(
      body.includes('### Emitted Artifact Provenance'),
      'the emitted-artifact family must be registered in the glossary'
    );
  });

  test('emittedArtifactProvenanceIsAConceptNotAModule', () => {
    const headings = actualHeadings(fs.readFileSync(CONTEXT_MD, 'utf-8'));
    assert.ok(headings.has('### Emitted Artifact Provenance'));
    assert.ok(
      !headings.has('### Emitted Artifact Provenance Module'),
      'it ships nothing, so it takes no `Module` suffix — follows the `### Resolution Provenance` precedent'
    );
  });
});

describe('CONTRIBUTING.md links contributor-standards.md', () => {
  test('CONTRIBUTING.md contains link to contributor-standards.md', () => {
    let contributing;
    try {
      contributing = fs.readFileSync(CONTRIBUTING_MD, 'utf-8');
    } catch (err) {
      assert.fail(`CONTRIBUTING.md does not exist: ${err.message}`);
    }
    assert.ok(
      contributing.includes('contributor-standards.md'),
      'CONTRIBUTING.md must link to docs/contributor-standards.md'
    );
  });
});

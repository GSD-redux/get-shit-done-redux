// docs-guard-exempt: docs/adr/NNNN.md below is a sourcePath metadata label passed to parseAdrMarkdown, never read from disk.
'use strict';

/**
 * Example-based unit tests for adr-parser.cjs
 *
 * Target: gsd-core/bin/lib/adr-parser.cjs
 * Purpose: kill surviving mutants by asserting EXACT values from every branch
 *
 * Gap coverage:
 *   - normalizeAdrHeader: each transformation step
 *   - classifyHeader (via parseAdrMarkdown): every CANONICAL_HEADERS key,
 *     prefix-match branch, unknown → unmapped_headers
 *   - parseSections: heading levels 1-6, CRLF, empty markdown, body-only,
 *     empty-heading guard, last section flushed
 *   - parseStatusFromSections: each keyword, empty body, custom passthrough
 *   - parseAdrMarkdown: title from H1, no-H1 title, format/sourcePath defaults,
 *     status fallback 'accepted', goal context-once guard, pushUnique dedup,
 *     all canonical section types
 *   - parseConsequences: every hint word, fallback positive
 *   - shouldRejectAdrStatus: uppercase/mixed-case normalisation path
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeAdrHeader,
  parseAdrMarkdown,
  shouldRejectAdrStatus,
  CANONICAL_HEADERS,
} = require('../gsd-core/bin/lib/adr-parser.cjs');

// ─────────────────────────────────────────────────────────────────────────────
// normalizeAdrHeader — exact transformation chain
// ─────────────────────────────────────────────────────────────────────────────
describe('normalizeAdrHeader', () => {
  test('returns empty string for non-string input (undefined)', () => {
    assert.equal(normalizeAdrHeader(undefined), '');
  });

  test('returns empty string for null', () => {
    assert.equal(normalizeAdrHeader(null), '');
  });

  test('returns empty string for number', () => {
    assert.equal(normalizeAdrHeader(42), '');
  });

  test('returns empty string for object', () => {
    assert.equal(normalizeAdrHeader({}), '');
  });

  test('trims leading/trailing whitespace', () => {
    assert.equal(normalizeAdrHeader('  status  '), 'status');
  });

  test('lowercases the string', () => {
    assert.equal(normalizeAdrHeader('STATUS'), 'status');
    assert.equal(normalizeAdrHeader('Context'), 'context');
  });

  test('collapses whitespace/colon/dot/underscore/hyphen runs to single space', () => {
    assert.equal(normalizeAdrHeader('out_of_scope'), 'out of scope');
    assert.equal(normalizeAdrHeader('plan-sequence'), 'plan sequence');
    assert.equal(normalizeAdrHeader('key.files'), 'key files');
    assert.equal(normalizeAdrHeader('status:'), 'status');
    assert.equal(normalizeAdrHeader('multiple   spaces'), 'multiple spaces');
  });

  test('removes non-word non-space characters', () => {
    // An exclamation mark is not \w or \s so it is stripped
    assert.equal(normalizeAdrHeader('status!'), 'status');
    assert.equal(normalizeAdrHeader('decisions?'), 'decisions');
  });

  test('trims again after removal (leading/trailing spaces from stripped chars)', () => {
    // If punctuation was adjacent to start/end, second trim fires
    assert.equal(normalizeAdrHeader('!status'), 'status');
    assert.equal(normalizeAdrHeader('status!'), 'status');
  });

  test('empty string returns empty string', () => {
    assert.equal(normalizeAdrHeader(''), '');
  });

  test('whitespace-only returns empty string', () => {
    assert.equal(normalizeAdrHeader('   '), '');
  });

  test('exact output for every CANONICAL_HEADERS key slug', () => {
    // status group
    assert.equal(normalizeAdrHeader('Status'), 'status');
    assert.equal(normalizeAdrHeader('State'), 'state');
    assert.equal(normalizeAdrHeader('Lifecycle'), 'lifecycle');
    assert.equal(normalizeAdrHeader('Stage'), 'stage');
    // goal group
    assert.equal(normalizeAdrHeader('Context'), 'context');
    assert.equal(normalizeAdrHeader('Background'), 'background');
    assert.equal(normalizeAdrHeader('Problem Statement'), 'problem statement');
    assert.equal(normalizeAdrHeader('Motivation'), 'motivation');
    assert.equal(normalizeAdrHeader('Drivers'), 'drivers');
    // decisions
    assert.equal(normalizeAdrHeader('Decision'), 'decision');
    assert.equal(normalizeAdrHeader('Resolution'), 'resolution');
    assert.equal(normalizeAdrHeader('We Decided'), 'we decided');
    // considered_options
    assert.equal(normalizeAdrHeader('Considered Options'), 'considered options');
    assert.equal(normalizeAdrHeader('Alternatives'), 'alternatives');
    assert.equal(normalizeAdrHeader('Trade-offs'), 'trade offs');
    // risks
    assert.equal(normalizeAdrHeader('Risks'), 'risks');
    assert.equal(normalizeAdrHeader('Drawbacks'), 'drawbacks');
    assert.equal(normalizeAdrHeader('Side Effects'), 'side effects');
    // success_criteria
    assert.equal(normalizeAdrHeader('Success Criteria'), 'success criteria');
    assert.equal(normalizeAdrHeader('Metrics'), 'metrics');
    assert.equal(normalizeAdrHeader('KPIs'), 'kpis');
    assert.equal(normalizeAdrHeader('Definition of Done'), 'definition of done');
    // plan_sequence
    assert.equal(normalizeAdrHeader('Implementation Plan'), 'implementation plan');
    assert.equal(normalizeAdrHeader('Roadmap'), 'roadmap');
    assert.equal(normalizeAdrHeader('Milestones'), 'milestones');
    // key_files
    assert.equal(normalizeAdrHeader('Affected Files'), 'affected files');
    assert.equal(normalizeAdrHeader('Diff Summary'), 'diff summary');
    // out_of_scope
    assert.equal(normalizeAdrHeader('Out of Scope'), 'out of scope');
    assert.equal(normalizeAdrHeader("Won't Do"), 'wont do');
    // deferred
    assert.equal(normalizeAdrHeader('Future Work'), 'future work');
    assert.equal(normalizeAdrHeader('Follow-up'), 'follow up');
    // dependencies
    assert.equal(normalizeAdrHeader('Dependencies'), 'dependencies');
    assert.equal(normalizeAdrHeader('Related ADRs'), 'related adrs');
    // update
    assert.equal(normalizeAdrHeader('Update'), 'update');
    assert.equal(normalizeAdrHeader('Amendment'), 'amendment');
    // consequences
    assert.equal(normalizeAdrHeader('Consequences'), 'consequences');
    assert.equal(normalizeAdrHeader('Implications'), 'implications');
    assert.equal(normalizeAdrHeader('Impact'), 'impact');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// CANONICAL_HEADERS — structure exported correctly
// ─────────────────────────────────────────────────────────────────────────────
describe('CANONICAL_HEADERS export', () => {
  test('exports CANONICAL_HEADERS as an object', () => {
    assert.ok(typeof CANONICAL_HEADERS === 'object' && CANONICAL_HEADERS !== null);
  });

  test('contains all 13 canonical keys', () => {
    const keys = Object.keys(CANONICAL_HEADERS);
    for (const k of ['status', 'goal', 'decisions', 'considered_options', 'risks',
      'success_criteria', 'plan_sequence', 'key_files', 'out_of_scope',
      'deferred', 'dependencies', 'update', 'consequences']) {
      assert.ok(keys.includes(k), `missing key: ${k}`);
    }
  });

  test('each canonical key maps to a non-empty array of strings', () => {
    for (const [key, synonyms] of Object.entries(CANONICAL_HEADERS)) {
      assert.ok(Array.isArray(synonyms), `${key} synonyms must be array`);
      assert.ok(synonyms.length > 0, `${key} synonyms must not be empty`);
      for (const syn of synonyms) {
        assert.equal(typeof syn, 'string', `${key} synonym must be string`);
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseSections behaviour (via parseAdrMarkdown on targeted inputs)
// ─────────────────────────────────────────────────────────────────────────────
describe('parseSections (via parseAdrMarkdown)', () => {
  test('empty string produces no title, no decisions, empty output', () => {
    const out = parseAdrMarkdown('');
    assert.equal(out.title, '');
    assert.deepEqual(out.decisions, []);
    assert.equal(out.status, 'accepted'); // fallback
  });

  test('body-only markdown (no headings) has empty title', () => {
    const out = parseAdrMarkdown('Just some text\nAnother line');
    assert.equal(out.title, '');
    assert.equal(out.status, 'accepted');
  });

  test('H1 heading extracts as title', () => {
    const out = parseAdrMarkdown('# My ADR Title\n\n## Status\nAccepted\n');
    assert.equal(out.title, 'My ADR Title');
  });

  test('H2 section heading is parsed (not title)', () => {
    const out = parseAdrMarkdown('## Decision\n- Do the thing.');
    assert.deepEqual(out.decisions, ['Do the thing.']);
    assert.equal(out.title, ''); // H2 is not extracted as title
  });

  test('H3 section heading is parsed', () => {
    const out = parseAdrMarkdown('# ADR\n\n### Decision\n- Sub-level choice.');
    assert.deepEqual(out.decisions, ['Sub-level choice.']);
  });

  test('H4 section heading is parsed', () => {
    const out = parseAdrMarkdown('#### Decision\n- Deep choice.');
    assert.deepEqual(out.decisions, ['Deep choice.']);
  });

  test('H5 section heading is parsed', () => {
    const out = parseAdrMarkdown('##### Decision\n- Very deep choice.');
    assert.deepEqual(out.decisions, ['Very deep choice.']);
  });

  test('H6 section heading is parsed', () => {
    const out = parseAdrMarkdown('###### Decision\n- Deepest choice.');
    assert.deepEqual(out.decisions, ['Deepest choice.']);
  });

  test('CRLF line endings are handled', () => {
    const out = parseAdrMarkdown('# ADR\r\n\r\n## Status\r\nAccepted\r\n\r\n## Decision\r\n- CRLF entry.');
    assert.equal(out.title, 'ADR');
    assert.equal(out.status, 'accepted');
    assert.deepEqual(out.decisions, ['CRLF entry.']);
  });

  test('multiple sections with same canonical key merge (pushUnique)', () => {
    const md = [
      '# ADR',
      '',
      '## Decision',
      '- First.',
      '',
      '## Resolution',
      '- Second.',
    ].join('\n');
    const out = parseAdrMarkdown(md);
    assert.deepEqual(out.decisions, ['First.', 'Second.']);
  });

  test('duplicate entries in pushUnique are deduplicated', () => {
    const md = [
      '# ADR',
      '',
      '## Decision',
      '- Same entry.',
      '',
      '## Resolution',
      '- Same entry.',
    ].join('\n');
    const out = parseAdrMarkdown(md);
    assert.deepEqual(out.decisions, ['Same entry.']);
  });

  test('unknown/unmapped heading added to unmapped_headers', () => {
    const md = [
      '# ADR',
      '',
      '## Custom Weird Section',
      'Content here.',
    ].join('\n');
    const out = parseAdrMarkdown(md);
    assert.ok(out.unmapped_headers.includes('Custom Weird Section'));
  });

  test('multiple unknown headings all in unmapped_headers', () => {
    const md = [
      '# ADR',
      '',
      '## Appendix A',
      'Some data.',
      '',
      '## Appendix B',
      'More data.',
    ].join('\n');
    const out = parseAdrMarkdown(md);
    assert.ok(out.unmapped_headers.includes('Appendix A'));
    assert.ok(out.unmapped_headers.includes('Appendix B'));
    // H1 "ADR" is also treated as a section heading and goes into unmapped_headers
    assert.ok(out.unmapped_headers.includes('ADR'));
    assert.equal(out.unmapped_headers.length, 3);
  });

  test('section with empty body produces empty entries', () => {
    const md = '# ADR\n\n## Decision\n\n## Context\nSome context.';
    const out = parseAdrMarkdown(md);
    assert.deepEqual(out.decisions, []);
    assert.ok(out.context.includes('Some context.'));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseAdrMarkdown — title extraction
// ─────────────────────────────────────────────────────────────────────────────
describe('parseAdrMarkdown: title extraction', () => {
  test('no H1 → empty title string', () => {
    const out = parseAdrMarkdown('## Status\nAccepted\n');
    assert.equal(out.title, '');
  });

  test('H1 with complex title preserved exactly', () => {
    const out = parseAdrMarkdown('# ADR-0042: Use TypeScript for new modules\n');
    assert.equal(out.title, 'ADR-0042: Use TypeScript for new modules');
  });

  test('H1 is found even when not on the first line', () => {
    const md = 'Some preamble\n\n# Actual Title\n\n## Status\nAccepted\n';
    const out = parseAdrMarkdown(md);
    assert.equal(out.title, 'Actual Title');
  });

  test('only the first H1 is taken as title', () => {
    const md = '# First Title\n# Second Title\n';
    const out = parseAdrMarkdown(md);
    assert.equal(out.title, 'First Title');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseAdrMarkdown — status extraction (all keyword branches)
// ─────────────────────────────────────────────────────────────────────────────
describe('parseAdrMarkdown: status extraction', () => {
  function makeStatusMd(statusText) {
    return `# ADR\n\n## Status\n${statusText}\n`;
  }

  test('status "accepted" (case-insensitive match)', () => {
    assert.equal(parseAdrMarkdown(makeStatusMd('Accepted')).status, 'accepted');
    assert.equal(parseAdrMarkdown(makeStatusMd('ACCEPTED')).status, 'accepted');
    assert.equal(parseAdrMarkdown(makeStatusMd('accepted')).status, 'accepted');
  });

  test('status "proposed" (case-insensitive match)', () => {
    assert.equal(parseAdrMarkdown(makeStatusMd('Proposed')).status, 'proposed');
    assert.equal(parseAdrMarkdown(makeStatusMd('PROPOSED')).status, 'proposed');
  });

  test('status "superseded" (case-insensitive match)', () => {
    assert.equal(parseAdrMarkdown(makeStatusMd('Superseded')).status, 'superseded');
    assert.equal(parseAdrMarkdown(makeStatusMd('SUPERSEDED')).status, 'superseded');
  });

  test('status "rejected" (case-insensitive match)', () => {
    assert.equal(parseAdrMarkdown(makeStatusMd('Rejected')).status, 'rejected');
  });

  test('status "deprecated" (case-insensitive match)', () => {
    assert.equal(parseAdrMarkdown(makeStatusMd('Deprecated')).status, 'deprecated');
  });

  test('status with surrounding text containing "accepted" keyword', () => {
    assert.equal(parseAdrMarkdown(makeStatusMd('Accepted by team on 2024-01')).status, 'accepted');
  });

  test('custom/unknown status is normalized and returned verbatim (normalized)', () => {
    // normalizeAdrHeader applied: lowercased, spaces collapsed
    assert.equal(parseAdrMarkdown(makeStatusMd('Active')).status, 'active');
    assert.equal(parseAdrMarkdown(makeStatusMd('Draft')).status, 'draft');
    assert.equal(parseAdrMarkdown(makeStatusMd('On Hold')).status, 'on hold');
  });

  test('status section with empty body → empty string → falls back to "accepted"', () => {
    // empty norm → returns '' → parseAdrMarkdown uses || 'accepted'
    const md = '# ADR\n\n## Status\n\n## Decision\n- Something.';
    const out = parseAdrMarkdown(md);
    assert.equal(out.status, 'accepted');
  });

  test('no status section → falls back to "accepted"', () => {
    const out = parseAdrMarkdown('# ADR\n\n## Context\nSome context.');
    assert.equal(out.status, 'accepted');
  });

  test('status synonym "State" maps to status section', () => {
    const out = parseAdrMarkdown('# ADR\n\n## State\nproposed\n');
    assert.equal(out.status, 'proposed');
  });

  test('status synonym "Lifecycle" maps to status section', () => {
    const out = parseAdrMarkdown('# ADR\n\n## Lifecycle\naccepted\n');
    assert.equal(out.status, 'accepted');
  });

  test('status synonym "Stage" maps to status section', () => {
    const out = parseAdrMarkdown('# ADR\n\n## Stage\ndraft\n');
    assert.equal(out.status, 'draft');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseAdrMarkdown — sourcePath and format options
// ─────────────────────────────────────────────────────────────────────────────
describe('parseAdrMarkdown: options', () => {
  test('sourcePath defaults to empty string', () => {
    const out = parseAdrMarkdown('# ADR\n');
    assert.equal(out.source_path, '');
  });

  test('sourcePath is preserved exactly', () => {
    const out = parseAdrMarkdown('# ADR\n', { sourcePath: 'docs/adr/0099.md' });
    assert.equal(out.source_path, 'docs/adr/0099.md');
  });

  test('format defaults to "auto"', () => {
    const out = parseAdrMarkdown('# ADR\n');
    assert.equal(out.format, 'auto');
  });

  test('format option is preserved exactly', () => {
    const out = parseAdrMarkdown('# ADR\n', { format: 'madr' });
    assert.equal(out.format, 'madr');
  });

  test('empty options object uses defaults', () => {
    const out = parseAdrMarkdown('# ADR\n', {});
    assert.equal(out.source_path, '');
    assert.equal(out.format, 'auto');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseAdrMarkdown — goal/context section
// ─────────────────────────────────────────────────────────────────────────────
describe('parseAdrMarkdown: goal/context section', () => {
  test('context set from "Context" heading', () => {
    const out = parseAdrMarkdown('# ADR\n\n## Context\nWe need to fix the build.');
    assert.equal(out.context.trim(), 'We need to fix the build.');
  });

  test('context set from "Background" heading', () => {
    const out = parseAdrMarkdown('# ADR\n\n## Background\nThe system is slow.');
    assert.equal(out.context.trim(), 'The system is slow.');
  });

  test('context set from "Problem Statement" heading', () => {
    const out = parseAdrMarkdown('# ADR\n\n## Problem Statement\nThe cache is broken.');
    assert.equal(out.context.trim(), 'The cache is broken.');
  });

  test('context only set from FIRST goal section (guard: !out.context)', () => {
    const md = [
      '# ADR',
      '',
      '## Context',
      'First context.',
      '',
      '## Background',
      'Second context.',
    ].join('\n');
    const out = parseAdrMarkdown(md);
    assert.equal(out.context.trim(), 'First context.');
  });

  test('context is empty string when no goal section', () => {
    const out = parseAdrMarkdown('# ADR\n\n## Decision\n- Do it.');
    assert.equal(out.context, '');
  });

  test('goal section with empty body does NOT set context', () => {
    const md = '# ADR\n\n## Context\n\n## Decision\n- Do it.';
    const out = parseAdrMarkdown(md);
    assert.equal(out.context, '');
  });

  test('"Situation" heading maps to goal/context', () => {
    const out = parseAdrMarkdown('# ADR\n\n## Situation\nSystem at capacity.');
    assert.equal(out.context.trim(), 'System at capacity.');
  });

  test('"Forces" heading maps to goal/context', () => {
    const out = parseAdrMarkdown('# ADR\n\n## Forces\nTime pressure.');
    assert.equal(out.context.trim(), 'Time pressure.');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseAdrMarkdown — decisions section
// ─────────────────────────────────────────────────────────────────────────────
describe('parseAdrMarkdown: decisions section', () => {
  test('"Decision" maps to decisions', () => {
    const out = parseAdrMarkdown('## Decision\n- Use TypeScript.');
    assert.deepEqual(out.decisions, ['Use TypeScript.']);
  });

  test('"Decisions" maps to decisions', () => {
    const out = parseAdrMarkdown('## Decisions\n- Use TypeScript.');
    assert.deepEqual(out.decisions, ['Use TypeScript.']);
  });

  test('"Resolution" maps to decisions', () => {
    const out = parseAdrMarkdown('## Resolution\n- Use TypeScript.');
    assert.deepEqual(out.decisions, ['Use TypeScript.']);
  });

  test('"Conclusion" maps to decisions', () => {
    const out = parseAdrMarkdown('## Conclusion\n- Refactor auth.');
    assert.deepEqual(out.decisions, ['Refactor auth.']);
  });

  test('"Choice" maps to decisions', () => {
    const out = parseAdrMarkdown('## Choice\n- GraphQL over REST.');
    assert.deepEqual(out.decisions, ['GraphQL over REST.']);
  });

  test('"We Decided" maps to decisions', () => {
    const out = parseAdrMarkdown('## We Decided\n- Adopt Rust.');
    assert.deepEqual(out.decisions, ['Adopt Rust.']);
  });

  test('"Direction" maps to decisions', () => {
    const out = parseAdrMarkdown('## Direction\n- Move to cloud.');
    assert.deepEqual(out.decisions, ['Move to cloud.']);
  });

  test('"Approach" maps to decisions', () => {
    const out = parseAdrMarkdown('## Approach\n- Use monorepo.');
    assert.deepEqual(out.decisions, ['Use monorepo.']);
  });

  test('"Solution" maps to decisions', () => {
    const out = parseAdrMarkdown('## Solution\n- Use Redis.');
    assert.deepEqual(out.decisions, ['Use Redis.']);
  });

  test('"Outcome" maps to decisions', () => {
    const out = parseAdrMarkdown('## Outcome\n- Deployed to prod.');
    assert.deepEqual(out.decisions, ['Deployed to prod.']);
  });

  test('"Selected Option" maps to decisions', () => {
    const out = parseAdrMarkdown('## Selected Option\n- Option A.');
    assert.deepEqual(out.decisions, ['Option A.']);
  });

  test('"Recommendation" maps to decisions', () => {
    const out = parseAdrMarkdown('## Recommendation\n- Do X.');
    assert.deepEqual(out.decisions, ['Do X.']);
  });

  test('"Strategy" maps to decisions', () => {
    const out = parseAdrMarkdown('## Strategy\n- Incremental rollout.');
    assert.deepEqual(out.decisions, ['Incremental rollout.']);
  });

  test('"Decision Outcome" maps to decisions', () => {
    const out = parseAdrMarkdown('## Decision Outcome\n- Ship it.');
    assert.deepEqual(out.decisions, ['Ship it.']);
  });

  test('bullet items stripped of marker characters', () => {
    const md = '## Decision\n- Dash item.\n* Star item.\n+ Plus item.';
    const out = parseAdrMarkdown(md);
    assert.deepEqual(out.decisions, ['Dash item.', 'Star item.', 'Plus item.']);
  });

  test('decisions is empty array when no decision section', () => {
    const out = parseAdrMarkdown('# ADR\n\n## Context\nSome context.');
    assert.deepEqual(out.decisions, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseAdrMarkdown — considered_options section
// ─────────────────────────────────────────────────────────────────────────────
describe('parseAdrMarkdown: considered_options section', () => {
  test('"Alternatives" maps to options_considered', () => {
    const out = parseAdrMarkdown('## Alternatives\n- Option B.');
    assert.deepEqual(out.options_considered, ['Option B.']);
  });

  test('"Options" maps to options_considered', () => {
    const out = parseAdrMarkdown('## Options\n- Option C.');
    assert.deepEqual(out.options_considered, ['Option C.']);
  });

  test('"Choices" maps to options_considered', () => {
    const out = parseAdrMarkdown('## Choices\n- Option D.');
    assert.deepEqual(out.options_considered, ['Option D.']);
  });

  test('"Candidates" maps to options_considered', () => {
    const out = parseAdrMarkdown('## Candidates\n- Candidate X.');
    assert.deepEqual(out.options_considered, ['Candidate X.']);
  });

  test('"Approaches Considered" maps to options_considered', () => {
    const out = parseAdrMarkdown('## Approaches Considered\n- Approach A.');
    assert.deepEqual(out.options_considered, ['Approach A.']);
  });

  test('"Variants" maps to options_considered', () => {
    const out = parseAdrMarkdown('## Variants\n- Variant 1.');
    assert.deepEqual(out.options_considered, ['Variant 1.']);
  });

  test('"Discussion" maps to options_considered', () => {
    const out = parseAdrMarkdown('## Discussion\n- Discussed approach.');
    assert.deepEqual(out.options_considered, ['Discussed approach.']);
  });

  test('"Pros and Cons of the Options" maps to options_considered', () => {
    const out = parseAdrMarkdown('## Pros and Cons of the Options\n- Pro: fast.');
    assert.deepEqual(out.options_considered, ['Pro: fast.']);
  });

  test('options_considered is empty when no section', () => {
    const out = parseAdrMarkdown('# ADR\n\n## Decision\n- Do it.');
    assert.deepEqual(out.options_considered, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseAdrMarkdown — risks section → consequences_negative
// ─────────────────────────────────────────────────────────────────────────────
describe('parseAdrMarkdown: risks section', () => {
  test('"Risks" maps to consequences_negative', () => {
    const out = parseAdrMarkdown('## Risks\n- Risk of outage.');
    assert.deepEqual(out.consequences_negative, ['Risk of outage.']);
    assert.deepEqual(out.consequences_positive, []);
  });

  test('"Trade-offs" maps to consequences_negative (M7: both sides normalized, synonym now reachable)', () => {
    const out = parseAdrMarkdown('## Trade-offs\n- Increased latency.');
    assert.deepEqual(out.consequences_negative, ['Increased latency.']);
    assert.ok(!out.unmapped_headers.includes('Trade-offs'));
  });

  test('"Drawbacks" maps to consequences_negative', () => {
    const out = parseAdrMarkdown('## Drawbacks\n- Higher cost.');
    assert.deepEqual(out.consequences_negative, ['Higher cost.']);
  });

  test('"Cost" maps to consequences_negative', () => {
    const out = parseAdrMarkdown('## Cost\n- Time investment.');
    assert.deepEqual(out.consequences_negative, ['Time investment.']);
  });

  test('"Tensions" maps to consequences_negative', () => {
    const out = parseAdrMarkdown('## Tensions\n- Team tension.');
    assert.deepEqual(out.consequences_negative, ['Team tension.']);
  });

  test('"Liabilities" maps to consequences_negative', () => {
    const out = parseAdrMarkdown('## Liabilities\n- Vendor lock-in.');
    assert.deepEqual(out.consequences_negative, ['Vendor lock-in.']);
  });

  test('"Negative Consequences" maps to consequences_negative', () => {
    const out = parseAdrMarkdown('## Negative Consequences\n- Debt.');
    assert.deepEqual(out.consequences_negative, ['Debt.']);
  });

  test('"Side Effects" maps to consequences_negative', () => {
    const out = parseAdrMarkdown('## Side Effects\n- Performance hit.');
    assert.deepEqual(out.consequences_negative, ['Performance hit.']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseAdrMarkdown — success_criteria section → consequences_positive
// ─────────────────────────────────────────────────────────────────────────────
describe('parseAdrMarkdown: success_criteria section', () => {
  test('"Success Criteria" maps to consequences_positive', () => {
    const out = parseAdrMarkdown('## Success Criteria\n- 99.9% uptime.');
    assert.deepEqual(out.consequences_positive, ['99.9% uptime.']);
    assert.deepEqual(out.consequences_negative, []);
  });

  test('"Acceptance Criteria" maps to consequences_positive', () => {
    const out = parseAdrMarkdown('## Acceptance Criteria\n- Tests pass.');
    assert.deepEqual(out.consequences_positive, ['Tests pass.']);
  });

  test('"Validation" maps to consequences_positive', () => {
    const out = parseAdrMarkdown('## Validation\n- Manual testing done.');
    assert.deepEqual(out.consequences_positive, ['Manual testing done.']);
  });

  test('"Metrics" maps to consequences_positive', () => {
    const out = parseAdrMarkdown('## Metrics\n- Latency < 100ms.');
    assert.deepEqual(out.consequences_positive, ['Latency < 100ms.']);
  });

  test('"KPIs" maps to consequences_positive', () => {
    const out = parseAdrMarkdown('## KPIs\n- Revenue up 10%.');
    assert.deepEqual(out.consequences_positive, ['Revenue up 10%.']);
  });

  test('"Verification" maps to consequences_positive', () => {
    const out = parseAdrMarkdown('## Verification\n- CI green.');
    assert.deepEqual(out.consequences_positive, ['CI green.']);
  });

  test('"Test Strategy" maps to consequences_positive', () => {
    const out = parseAdrMarkdown('## Test Strategy\n- Unit + integration.');
    assert.deepEqual(out.consequences_positive, ['Unit + integration.']);
  });

  test('"Definition of Done" maps to consequences_positive', () => {
    const out = parseAdrMarkdown('## Definition of Done\n- Merged and deployed.');
    assert.deepEqual(out.consequences_positive, ['Merged and deployed.']);
  });

  test('"Exit Criteria" maps to consequences_positive', () => {
    const out = parseAdrMarkdown('## Exit Criteria\n- No open P0 bugs.');
    assert.deepEqual(out.consequences_positive, ['No open P0 bugs.']);
  });

  test('"Positive Consequences" maps to consequences_positive', () => {
    const out = parseAdrMarkdown('## Positive Consequences\n- Better DX.');
    assert.deepEqual(out.consequences_positive, ['Better DX.']);
  });

  test('"How We\'ll Know" maps to consequences_positive (M7: synonym normalized on both sides, now reachable)', () => {
    // The apostrophe in "we'll" is stripped by normalizeAdrHeader on BOTH the header and the
    // synonym, so both yield "how well know" and now match (success_criteria → consequences_positive).
    const out = parseAdrMarkdown("## How We'll Know\n- Sales increase.");
    assert.deepEqual(out.consequences_positive, ['Sales increase.']);
    assert.ok(!out.unmapped_headers.includes("How We'll Know"));
  });

  test('"Compliance" maps to consequences_positive', () => {
    const out = parseAdrMarkdown('## Compliance\n- SOC2 passed.');
    assert.deepEqual(out.consequences_positive, ['SOC2 passed.']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseConsequences — hint-based triage (via Consequences heading)
// ─────────────────────────────────────────────────────────────────────────────
describe('parseConsequences (via Consequences section)', () => {
  function makeConsequencesMd(entries) {
    return `# ADR\n\n## Consequences\n${entries.map((e) => `- ${e}`).join('\n')}\n`;
  }

  test('entry containing "negative" → consequences_negative', () => {
    const out = parseAdrMarkdown(makeConsequencesMd(['negative: cost increases']));
    assert.deepEqual(out.consequences_negative, ['negative: cost increases']);
    assert.deepEqual(out.consequences_positive, []);
  });

  test('entry containing "drawback" → consequences_negative', () => {
    const out = parseAdrMarkdown(makeConsequencesMd(['One drawback: overhead']));
    assert.deepEqual(out.consequences_negative, ['One drawback: overhead']);
  });

  test('entry containing "risk" → consequences_negative', () => {
    const out = parseAdrMarkdown(makeConsequencesMd(['risk of data loss']));
    assert.deepEqual(out.consequences_negative, ['risk of data loss']);
  });

  test('entry containing "cost" → consequences_negative', () => {
    const out = parseAdrMarkdown(makeConsequencesMd(['high cost to maintain']));
    assert.deepEqual(out.consequences_negative, ['high cost to maintain']);
  });

  test('entry containing "liability" → consequences_negative', () => {
    const out = parseAdrMarkdown(makeConsequencesMd(['legal liability risk']));
    assert.deepEqual(out.consequences_negative, ['legal liability risk']);
  });

  test('entry containing "trade-off" → consequences_negative', () => {
    const out = parseAdrMarkdown(makeConsequencesMd(['this trade-off is worth it']));
    assert.deepEqual(out.consequences_negative, ['this trade-off is worth it']);
  });

  test('entry containing "tension" → consequences_negative', () => {
    const out = parseAdrMarkdown(makeConsequencesMd(['team tension exists']));
    assert.deepEqual(out.consequences_negative, ['team tension exists']);
  });

  test('entry containing "side effect" → consequences_negative', () => {
    const out = parseAdrMarkdown(makeConsequencesMd(['side effect: memory growth']));
    assert.deepEqual(out.consequences_negative, ['side effect: memory growth']);
  });

  test('entry containing "positive" → consequences_positive', () => {
    const out = parseAdrMarkdown(makeConsequencesMd(['positive: faster deploys']));
    assert.deepEqual(out.consequences_positive, ['positive: faster deploys']);
    assert.deepEqual(out.consequences_negative, []);
  });

  test('entry containing "success" → consequences_positive', () => {
    const out = parseAdrMarkdown(makeConsequencesMd(['success rate improves']));
    assert.deepEqual(out.consequences_positive, ['success rate improves']);
  });

  test('entry containing "metric" → consequences_positive', () => {
    const out = parseAdrMarkdown(makeConsequencesMd(['metric: latency < 100ms']));
    assert.deepEqual(out.consequences_positive, ['metric: latency < 100ms']);
  });

  test('entry containing "kpi" → consequences_positive', () => {
    const out = parseAdrMarkdown(makeConsequencesMd(['kpi tracked monthly']));
    assert.deepEqual(out.consequences_positive, ['kpi tracked monthly']);
  });

  test('entry containing "verification" → consequences_positive', () => {
    const out = parseAdrMarkdown(makeConsequencesMd(['verification: run test suite']));
    assert.deepEqual(out.consequences_positive, ['verification: run test suite']);
  });

  test('entry containing "acceptance" → consequences_positive', () => {
    const out = parseAdrMarkdown(makeConsequencesMd(['acceptance tests pass']));
    assert.deepEqual(out.consequences_positive, ['acceptance tests pass']);
  });

  test('entry containing "benefit" → consequences_positive', () => {
    const out = parseAdrMarkdown(makeConsequencesMd(['benefit: faster CI']));
    assert.deepEqual(out.consequences_positive, ['benefit: faster CI']);
  });

  test('entry with no hint → fallback to consequences_positive', () => {
    const out = parseAdrMarkdown(makeConsequencesMd(['General observation.']));
    assert.deepEqual(out.consequences_positive, ['General observation.']);
    assert.deepEqual(out.consequences_negative, []);
  });

  test('multiple entries each triaged independently', () => {
    const entries = [
      'negative: first bad thing',
      'positive: first good thing',
      'no hint here',
      'drawback: another bad thing',
      'benefit: another good thing',
    ];
    const out = parseAdrMarkdown(makeConsequencesMd(entries));
    assert.deepEqual(out.consequences_negative, [
      'negative: first bad thing',
      'drawback: another bad thing',
    ]);
    assert.deepEqual(out.consequences_positive, [
      'positive: first good thing',
      'no hint here',
      'benefit: another good thing',
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseAdrMarkdown — plan_sequence section
// ─────────────────────────────────────────────────────────────────────────────
describe('parseAdrMarkdown: plan_sequence section', () => {
  test('"Implementation Plan" maps to plan_sequence', () => {
    const out = parseAdrMarkdown('## Implementation Plan\n- Step 1.');
    assert.deepEqual(out.plan_sequence, ['Step 1.']);
  });

  test('"Implementation Notes" maps to plan_sequence', () => {
    const out = parseAdrMarkdown('## Implementation Notes\n- Note 1.');
    assert.deepEqual(out.plan_sequence, ['Note 1.']);
  });

  test('"Steps" maps to plan_sequence', () => {
    const out = parseAdrMarkdown('## Steps\n- Do A.\n- Do B.');
    assert.deepEqual(out.plan_sequence, ['Do A.', 'Do B.']);
  });

  test('"Tasks" maps to plan_sequence', () => {
    const out = parseAdrMarkdown('## Tasks\n- Task 1.');
    assert.deepEqual(out.plan_sequence, ['Task 1.']);
  });

  test('"Roadmap" maps to plan_sequence', () => {
    const out = parseAdrMarkdown('## Roadmap\n- Q1: alpha.');
    assert.deepEqual(out.plan_sequence, ['Q1: alpha.']);
  });

  test('"Sequence" maps to plan_sequence', () => {
    const out = parseAdrMarkdown('## Sequence\n- Phase 1.');
    assert.deepEqual(out.plan_sequence, ['Phase 1.']);
  });

  test('"Migration Plan" maps to plan_sequence', () => {
    const out = parseAdrMarkdown('## Migration Plan\n- Migrate DB first.');
    assert.deepEqual(out.plan_sequence, ['Migrate DB first.']);
  });

  test('"Plan" maps to plan_sequence', () => {
    const out = parseAdrMarkdown('## Plan\n- Create ticket.');
    assert.deepEqual(out.plan_sequence, ['Create ticket.']);
  });

  test('"Action Items" maps to plan_sequence', () => {
    const out = parseAdrMarkdown('## Action Items\n- Fix bug.');
    assert.deepEqual(out.plan_sequence, ['Fix bug.']);
  });

  test('"Work Breakdown" maps to plan_sequence', () => {
    const out = parseAdrMarkdown('## Work Breakdown\n- Backend sprint.');
    assert.deepEqual(out.plan_sequence, ['Backend sprint.']);
  });

  test('"Phases" maps to plan_sequence', () => {
    const out = parseAdrMarkdown('## Phases\n- Phase A.');
    assert.deepEqual(out.plan_sequence, ['Phase A.']);
  });

  test('"Milestones" maps to plan_sequence', () => {
    const out = parseAdrMarkdown('## Milestones\n- v1.0 release.');
    assert.deepEqual(out.plan_sequence, ['v1.0 release.']);
  });

  test('"Stages" maps to plan_sequence', () => {
    const out = parseAdrMarkdown('## Stages\n- Stage 1: prototype.');
    assert.deepEqual(out.plan_sequence, ['Stage 1: prototype.']);
  });

  test('plan_sequence is empty when no section', () => {
    const out = parseAdrMarkdown('# ADR\n');
    assert.deepEqual(out.plan_sequence, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseAdrMarkdown — key_files section
// ─────────────────────────────────────────────────────────────────────────────
describe('parseAdrMarkdown: key_files section', () => {
  test('"Affected Files" maps to key_files', () => {
    const out = parseAdrMarkdown('## Affected Files\n- src/index.ts');
    assert.deepEqual(out.key_files, ['src/index.ts']);
  });

  test('"Files Touched" maps to key_files', () => {
    const out = parseAdrMarkdown('## Files Touched\n- lib/core.js');
    assert.deepEqual(out.key_files, ['lib/core.js']);
  });

  test('"Surface Area" maps to key_files', () => {
    const out = parseAdrMarkdown('## Surface Area\n- api/routes.ts');
    assert.deepEqual(out.key_files, ['api/routes.ts']);
  });

  test('"Modules Affected" maps to key_files', () => {
    const out = parseAdrMarkdown('## Modules Affected\n- auth module');
    assert.deepEqual(out.key_files, ['auth module']);
  });

  test('"Code Locations" maps to key_files', () => {
    const out = parseAdrMarkdown('## Code Locations\n- src/parser.ts');
    assert.deepEqual(out.key_files, ['src/parser.ts']);
  });

  test('"File Changes" maps to key_files', () => {
    const out = parseAdrMarkdown('## File Changes\n- config.json');
    assert.deepEqual(out.key_files, ['config.json']);
  });

  test('"Diff Summary" maps to key_files', () => {
    const out = parseAdrMarkdown('## Diff Summary\n- +50 -10 lines');
    assert.deepEqual(out.key_files, ['+50 -10 lines']);
  });

  test('"Touched Code" maps to key_files', () => {
    const out = parseAdrMarkdown('## Touched Code\n- helpers.ts');
    assert.deepEqual(out.key_files, ['helpers.ts']);
  });

  test('key_files is empty when no section', () => {
    const out = parseAdrMarkdown('# ADR\n');
    assert.deepEqual(out.key_files, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseAdrMarkdown — out_of_scope section
// ─────────────────────────────────────────────────────────────────────────────
describe('parseAdrMarkdown: out_of_scope section', () => {
  test('"Non-goals" maps to out_of_scope (M7: both sides normalized to "non goals", now reachable)', () => {
    const out = parseAdrMarkdown('## Non-goals\n- Not this.');
    assert.deepEqual(out.out_of_scope, ['Not this.']);
    assert.ok(!out.unmapped_headers.includes('Non-goals'));
  });

  test('"Excluded" maps to out_of_scope', () => {
    const out = parseAdrMarkdown('## Excluded\n- Feature X.');
    assert.deepEqual(out.out_of_scope, ['Feature X.']);
  });

  test('"Not in this ADR" maps to out_of_scope', () => {
    const out = parseAdrMarkdown('## Not in this ADR\n- Remote ingest.');
    assert.deepEqual(out.out_of_scope, ['Remote ingest.']);
  });

  test('"Out of Bounds" maps to out_of_scope', () => {
    const out = parseAdrMarkdown('## Out of Bounds\n- Infrastructure.');
    assert.deepEqual(out.out_of_scope, ['Infrastructure.']);
  });

  test('"Beyond Scope" maps to out_of_scope', () => {
    const out = parseAdrMarkdown('## Beyond Scope\n- Billing system.');
    assert.deepEqual(out.out_of_scope, ['Billing system.']);
  });

  test('"Anti-goals" maps to out_of_scope (M7: both sides normalized to "anti goals", now reachable)', () => {
    const out = parseAdrMarkdown('## Anti-goals\n- Gold plating.');
    assert.deepEqual(out.out_of_scope, ['Gold plating.']);
    assert.ok(!out.unmapped_headers.includes('Anti-goals'));
  });

  test('out_of_scope is empty when no section', () => {
    const out = parseAdrMarkdown('# ADR\n');
    assert.deepEqual(out.out_of_scope, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseAdrMarkdown — deferred section
// ─────────────────────────────────────────────────────────────────────────────
describe('parseAdrMarkdown: deferred section', () => {
  test('"Deferred" maps to deferred', () => {
    const out = parseAdrMarkdown('## Deferred\n- Caching layer.');
    assert.deepEqual(out.deferred, ['Caching layer.']);
  });

  test('"Future" maps to deferred', () => {
    const out = parseAdrMarkdown('## Future\n- API v2.');
    assert.deepEqual(out.deferred, ['API v2.']);
  });

  test('"Later" maps to deferred', () => {
    const out = parseAdrMarkdown('## Later\n- Optimize later.');
    assert.deepEqual(out.deferred, ['Optimize later.']);
  });

  test('"Follow-up" maps to deferred (M7: both sides normalized to "follow up", now reachable)', () => {
    const out = parseAdrMarkdown('## Follow-up\n- Monitor metrics.');
    assert.deepEqual(out.deferred, ['Monitor metrics.']);
    assert.ok(!out.unmapped_headers.includes('Follow-up'));
  });

  test('"Next Steps" maps to deferred', () => {
    const out = parseAdrMarkdown('## Next Steps\n- Schedule review.');
    assert.deepEqual(out.deferred, ['Schedule review.']);
  });

  test('deferred is empty when no section', () => {
    const out = parseAdrMarkdown('# ADR\n');
    assert.deepEqual(out.deferred, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseAdrMarkdown — dependencies section
// ─────────────────────────────────────────────────────────────────────────────
describe('parseAdrMarkdown: dependencies section', () => {
  test('"Depends On" maps to dependencies', () => {
    const out = parseAdrMarkdown('## Depends On\n- ADR-0001');
    assert.deepEqual(out.dependencies, ['ADR-0001']);
  });

  test('"Prerequisites" maps to dependencies', () => {
    const out = parseAdrMarkdown('## Prerequisites\n- Node.js 18');
    assert.deepEqual(out.dependencies, ['Node.js 18']);
  });

  test('"Sequencing" maps to dependencies', () => {
    const out = parseAdrMarkdown('## Sequencing\n- Must follow ADR-003.');
    assert.deepEqual(out.dependencies, ['Must follow ADR-003.']);
  });

  test('"Order" maps to dependencies', () => {
    const out = parseAdrMarkdown('## Order\n- ADR-002 first.');
    assert.deepEqual(out.dependencies, ['ADR-002 first.']);
  });

  test('"Blocked By" maps to dependencies', () => {
    const out = parseAdrMarkdown('## Blocked By\n- Team capacity.');
    assert.deepEqual(out.dependencies, ['Team capacity.']);
  });

  test('"Cross-cuts" maps to dependencies (M7: both sides normalized to "cross cuts", now reachable)', () => {
    const out = parseAdrMarkdown('## Cross-cuts\n- Security layer.');
    assert.deepEqual(out.dependencies, ['Security layer.']);
    assert.ok(!out.unmapped_headers.includes('Cross-cuts'));
  });

  test('"Related ADRs" maps to dependencies', () => {
    const out = parseAdrMarkdown('## Related ADRs\n- ADR-0003');
    assert.deepEqual(out.dependencies, ['ADR-0003']);
  });

  test('"Links" maps to dependencies', () => {
    const out = parseAdrMarkdown('## Links\n- https://example.com');
    assert.deepEqual(out.dependencies, ['https://example.com']);
  });

  test('"References" maps to dependencies', () => {
    const out = parseAdrMarkdown('## References\n- RFC 9110');
    assert.deepEqual(out.dependencies, ['RFC 9110']);
  });

  test('"See Also" maps to dependencies', () => {
    const out = parseAdrMarkdown('## See Also\n- ADR-0005');
    assert.deepEqual(out.dependencies, ['ADR-0005']);
  });

  test('"Upstream" maps to dependencies', () => {
    const out = parseAdrMarkdown('## Upstream\n- Platform team.');
    assert.deepEqual(out.dependencies, ['Platform team.']);
  });

  test('"Inbound" maps to dependencies', () => {
    const out = parseAdrMarkdown('## Inbound\n- From ADR-0007.');
    assert.deepEqual(out.dependencies, ['From ADR-0007.']);
  });

  test('dependencies is empty when no section', () => {
    const out = parseAdrMarkdown('# ADR\n');
    assert.deepEqual(out.dependencies, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseAdrMarkdown — update section
// ─────────────────────────────────────────────────────────────────────────────
describe('parseAdrMarkdown: update section', () => {
  test('"Revision" maps to updates', () => {
    const out = parseAdrMarkdown('## Revision\n- Changed the approach.');
    assert.equal(out.updates.length, 1);
    assert.equal(out.updates[0].heading, 'Revision');
    assert.deepEqual(out.updates[0].entries, ['Changed the approach.']);
  });

  test('"Amendment" maps to updates', () => {
    const out = parseAdrMarkdown('## Amendment\n- Added exception.');
    assert.equal(out.updates.length, 1);
    assert.equal(out.updates[0].heading, 'Amendment');
  });

  test('"Locked Design" maps to updates', () => {
    const out = parseAdrMarkdown('## Locked Design\n- Locked.', { sourcePath: '' });
    assert.equal(out.updates.length, 1);
  });

  test('"Final Decision" maps to updates', () => {
    const out = parseAdrMarkdown('## Final Decision\n- Ship v2.');
    assert.equal(out.updates.length, 1);
    assert.deepEqual(out.updates[0].entries, ['Ship v2.']);
  });

  test('"Post-grilling" maps to updates (M7: both sides normalized to "post grilling", now reachable)', () => {
    const out = parseAdrMarkdown('## Post-grilling\n- Revised after review.');
    assert.equal(out.updates.length, 1);
    assert.deepEqual(out.updates[0].entries, ['Revised after review.']);
    assert.ok(!out.unmapped_headers.includes('Post-grilling'));
  });

  test('"Addendum" maps to updates', () => {
    const out = parseAdrMarkdown('## Addendum\n- Minor addition.');
    assert.equal(out.updates.length, 1);
    assert.deepEqual(out.updates[0].entries, ['Minor addition.']);
  });

  test('update section captures heading verbatim', () => {
    const out = parseAdrMarkdown('## Update — locked design\n- Changed on 2024-01-01.');
    assert.equal(out.updates[0].heading, 'Update — locked design');
  });

  test('multiple update sections produce multiple entries', () => {
    const md = [
      '## Update',
      '- First update.',
      '',
      '## Revision',
      '- Second update.',
    ].join('\n');
    const out = parseAdrMarkdown(md);
    assert.equal(out.updates.length, 2);
    assert.equal(out.updates[0].heading, 'Update');
    assert.equal(out.updates[1].heading, 'Revision');
  });

  test('updates is empty when no update section', () => {
    const out = parseAdrMarkdown('# ADR\n\n## Decision\n- Do it.');
    assert.deepEqual(out.updates, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// parseAdrMarkdown — consequences section
// ─────────────────────────────────────────────────────────────────────────────
describe('parseAdrMarkdown: consequences canonical section', () => {
  test('"Implications" maps to consequences (parsed via parseConsequences)', () => {
    const out = parseAdrMarkdown('## Implications\n- negative: some drawback\n- positive: some benefit');
    assert.deepEqual(out.consequences_negative, ['negative: some drawback']);
    assert.deepEqual(out.consequences_positive, ['positive: some benefit']);
  });

  test('"Impact" maps to consequences', () => {
    const out = parseAdrMarkdown('## Impact\n- risk of regression\n- benefit: faster');
    assert.deepEqual(out.consequences_negative, ['risk of regression']);
    assert.deepEqual(out.consequences_positive, ['benefit: faster']);
  });

  test('"What This Means" maps to consequences', () => {
    const out = parseAdrMarkdown('## What This Means\n- General finding.');
    assert.deepEqual(out.consequences_positive, ['General finding.']);
  });

  test('"Result" maps to consequences', () => {
    const out = parseAdrMarkdown('## Result\n- drawback: extra cost');
    assert.deepEqual(out.consequences_negative, ['drawback: extra cost']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyHeader — cross-bucket synonym collision (audit M7)
// 'trade-offs' must resolve to risks (consequences_negative), not considered_options.
// CANONICAL_HEADERS once listed 'trade-offs' under BOTH buckets; classifyHeader is
// first-match-wins over Object.entries and considered_options is declared first, so
// '## Trade-offs' always misclassified as options and the risks entry was dead code.
// ─────────────────────────────────────────────────────────────────────────────
describe('parseAdrMarkdown: punctuated synonyms are reachable (M7)', () => {
  // Root cause: classifyHeader receives a normalized header but historically compared it
  // against RAW synonyms; normalizeAdrHeader collapses [\s:._-]+ → space and strips [^\w\s],
  // so any synonym with a hyphen/apostrophe was dead and its section went unmapped. The fix
  // normalizes both sides, making the whole class reachable while the table stays readable.
  test('"## Trade-offs" lands in consequences_negative (risks), not options_considered', () => {
    const out = parseAdrMarkdown('## Trade-offs\n- adds a per-acquire syscall\n- larger lock body');
    assert.deepEqual(out.consequences_negative, ['adds a per-acquire syscall', 'larger lock body']);
    assert.deepEqual(out.options_considered, []);
  });

  test('all formerly-dead punctuated headers now classify to their bucket', () => {
    assert.deepEqual(parseAdrMarkdown('## Non-Goals\n- x').out_of_scope, ['x']);
    assert.deepEqual(parseAdrMarkdown('## Anti-Goals\n- x').out_of_scope, ['x']);
    assert.deepEqual(parseAdrMarkdown("## Won't Do\n- x").out_of_scope, ['x']);
    assert.deepEqual(parseAdrMarkdown('## Follow-up\n- x').deferred, ['x']);
    assert.deepEqual(parseAdrMarkdown('## Cross-cuts\n- x').dependencies, ['x']);
    assert.deepEqual(parseAdrMarkdown("## How We'll Know\n- x").consequences_positive, ['x']);
    assert.equal(parseAdrMarkdown('## Post-grilling\n- 2026-01-01: note').updates[0].heading, 'Post-grilling');
  });

  test("'trade-offs' lives only in risks (de-duped from considered_options to avoid a cross-bucket collision)", () => {
    assert.ok(!CANONICAL_HEADERS.considered_options.includes('trade-offs'));
    assert.ok(CANONICAL_HEADERS.risks.includes('trade-offs'));
  });

  // Reachability invariant — guards the whole class against regression: every synonym in
  // CANONICAL_HEADERS must classify (a header written as that synonym is never unmapped),
  // and no two synonyms may normalize into different buckets (cross-bucket collision).
  test('invariant: every CANONICAL_HEADERS synonym is reachable and collision-free', () => {
    const byNormalized = new Map();
    for (const [bucket, synonyms] of Object.entries(CANONICAL_HEADERS)) {
      for (const syn of synonyms) {
        const out = parseAdrMarkdown(`## ${syn}\n- z`);
        assert.ok(!out.unmapped_headers.includes(syn), `synonym "${syn}" (bucket ${bucket}) is unreachable`);
        const n = syn.toLowerCase().replace(/[\s:._-]+/g, ' ').replace(/[^\w\s]/g, '').trim();
        if (byNormalized.has(n)) {
          assert.equal(byNormalized.get(n), bucket, `normalized synonym "${n}" collides across buckets (${byNormalized.get(n)} vs ${bucket})`);
        } else {
          byNormalized.set(n, bucket);
        }
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// classifyHeader — prefix-match branch
// ─────────────────────────────────────────────────────────────────────────────
describe('classifyHeader prefix-match (via parseAdrMarkdown)', () => {
  test('heading that starts with a synonym prefix is classified', () => {
    // "status " prefix match: "status as of 2024" → starts with "status "
    const out = parseAdrMarkdown('## Status as of 2024\naccepted\n');
    assert.equal(out.status, 'accepted');
  });

  test('heading that starts with "context " prefix is classified as goal', () => {
    const out = parseAdrMarkdown('## Context and Problem Statement\nSome context.');
    assert.equal(out.context.trim(), 'Some context.');
  });

  test('heading that starts with "decision " prefix is classified as decisions', () => {
    const out = parseAdrMarkdown('## Decision Outcome\n- Use option A.');
    assert.deepEqual(out.decisions, ['Use option A.']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// shouldRejectAdrStatus — normalisation path (uppercase/mixed)
// ─────────────────────────────────────────────────────────────────────────────
describe('shouldRejectAdrStatus: normalisation', () => {
  test('uppercase "SUPERSEDED" is rejected (normalised before Set check)', () => {
    assert.equal(shouldRejectAdrStatus('SUPERSEDED'), true);
  });

  test('uppercase "REJECTED" is rejected', () => {
    assert.equal(shouldRejectAdrStatus('REJECTED'), true);
  });

  test('uppercase "DEPRECATED" is rejected', () => {
    assert.equal(shouldRejectAdrStatus('DEPRECATED'), true);
  });

  test('mixed-case "Superseded" is rejected', () => {
    assert.equal(shouldRejectAdrStatus('Superseded'), true);
  });

  test('mixed-case "Rejected" is rejected', () => {
    assert.equal(shouldRejectAdrStatus('Rejected'), true);
  });

  test('mixed-case "Deprecated" is rejected', () => {
    assert.equal(shouldRejectAdrStatus('Deprecated'), true);
  });

  test('"accepted" is not rejected', () => {
    assert.equal(shouldRejectAdrStatus('accepted'), false);
  });

  test('"proposed" is not rejected', () => {
    assert.equal(shouldRejectAdrStatus('proposed'), false);
  });

  test('"active" is not rejected', () => {
    assert.equal(shouldRejectAdrStatus('active'), false);
  });

  test('empty string is not rejected', () => {
    assert.equal(shouldRejectAdrStatus(''), false);
  });

  test('non-string returns false (does not throw)', () => {
    assert.equal(shouldRejectAdrStatus(null), false);
    assert.equal(shouldRejectAdrStatus(undefined), false);
    assert.equal(shouldRejectAdrStatus(42), false);
  });

  test('status with punctuation normalised: "superseded." is rejected', () => {
    // normalizeAdrHeader strips . → "superseded" → rejected
    assert.equal(shouldRejectAdrStatus('superseded.'), true);
  });

  test('status with extra spaces: " rejected " is rejected', () => {
    assert.equal(shouldRejectAdrStatus(' rejected '), true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// splitEntries behaviour (via parseAdrMarkdown)
// ─────────────────────────────────────────────────────────────────────────────
describe('splitEntries (via parseAdrMarkdown decisions)', () => {
  test('dash-prefixed entries stripped', () => {
    const out = parseAdrMarkdown('## Decision\n- Entry one.\n- Entry two.');
    assert.deepEqual(out.decisions, ['Entry one.', 'Entry two.']);
  });

  test('star-prefixed entries stripped', () => {
    const out = parseAdrMarkdown('## Decision\n* Star entry.');
    assert.deepEqual(out.decisions, ['Star entry.']);
  });

  test('plus-prefixed entries stripped', () => {
    const out = parseAdrMarkdown('## Decision\n+ Plus entry.');
    assert.deepEqual(out.decisions, ['Plus entry.']);
  });

  test('blank lines between entries filtered out', () => {
    const out = parseAdrMarkdown('## Decision\n- First.\n\n- Second.');
    assert.deepEqual(out.decisions, ['First.', 'Second.']);
  });

  test('plain text without bullet still included', () => {
    const out = parseAdrMarkdown('## Decision\nPlain text entry.');
    assert.deepEqual(out.decisions, ['Plain text entry.']);
  });

  test('lines with only whitespace filtered', () => {
    const out = parseAdrMarkdown('## Decision\n   \n- Real entry.\n  ');
    assert.deepEqual(out.decisions, ['Real entry.']);
  });

  // Regression guard for ADR-1372 T2: iterateBullets folded indented non-bullet
  // lines into the preceding bullet — the flat splitEntries must keep them.
  test('indented non-bullet line (4-space) kept verbatim as its own entry', () => {
    const md = '## Decision\n- Bullet entry\n    indented non-bullet line\n- Another bullet';
    const out = parseAdrMarkdown(md);
    assert.deepEqual(out.decisions, ['Bullet entry', 'indented non-bullet line', 'Another bullet']);
  });

  // Regression guard for ADR-1372 T2: iterateBullets stripped numbered markers
  // ("1. Foo" → "Foo") — the flat splitEntries only strips [-*+], not numbers.
  test('numbered list item kept verbatim (not stripped to bare text)', () => {
    const md = '## Decision\n1. First\n2. Second';
    const out = parseAdrMarkdown(md);
    assert.deepEqual(out.decisions, ['1. First', '2. Second']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Full integration: all sections in one document
// ─────────────────────────────────────────────────────────────────────────────
describe('parseAdrMarkdown: full document integration', () => {
  test('complete ADR with all section types parsed correctly', () => {
    const md = [
      '# ADR-0001: Switch to PostgreSQL',
      '',
      '## Status',
      'Accepted',
      '',
      '## Context',
      'The SQLite database cannot handle concurrent writes.',
      '',
      '## Decision',
      '- Migrate to PostgreSQL.',
      '- Use connection pooling.',
      '',
      '## Considered Options',
      '- Stay with SQLite.',
      '- Use CockroachDB.',
      '',
      '## Success Criteria',
      '- Zero data loss.',
      '- 99.9% uptime maintained.',
      '',
      '## Risks',
      '- Migration downtime.',
      '',
      '## Implementation Plan',
      '- Step 1: Set up Postgres.',
      '- Step 2: Migrate data.',
      '',
      '## Affected Files',
      '- src/db/client.ts',
      '',
      '## Out of Scope',
      '- Redis integration.',
      '',
      '## Future Work',
      '- Connection sharding.',
      '',
      '## Dependencies',
      '- ADR-0000',
      '',
      '## Update',
      '- Changed connection pool size to 20.',
      '',
      '## Consequences',
      '- negative: higher operational cost.',
      '- positive: improved throughput.',
    ].join('\n');

    const out = parseAdrMarkdown(md, { sourcePath: 'docs/adr/0001.md', format: 'custom' });

    assert.equal(out.title, 'ADR-0001: Switch to PostgreSQL');
    assert.equal(out.status, 'accepted');
    assert.equal(out.source_path, 'docs/adr/0001.md');
    assert.equal(out.format, 'custom');
    assert.equal(out.context.trim(), 'The SQLite database cannot handle concurrent writes.');
    assert.deepEqual(out.decisions, ['Migrate to PostgreSQL.', 'Use connection pooling.']);
    assert.deepEqual(out.options_considered, ['Stay with SQLite.', 'Use CockroachDB.']);
    assert.deepEqual(out.consequences_positive, ['Zero data loss.', '99.9% uptime maintained.', 'positive: improved throughput.']);
    assert.deepEqual(out.consequences_negative, ['Migration downtime.', 'negative: higher operational cost.']);
    assert.deepEqual(out.plan_sequence, ['Step 1: Set up Postgres.', 'Step 2: Migrate data.']);
    assert.deepEqual(out.key_files, ['src/db/client.ts']);
    assert.deepEqual(out.out_of_scope, ['Redis integration.']);
    assert.deepEqual(out.deferred, ['Connection sharding.']);
    assert.deepEqual(out.dependencies, ['ADR-0000']);
    assert.equal(out.updates.length, 1);
    assert.equal(out.updates[0].heading, 'Update');
    assert.deepEqual(out.updates[0].entries, ['Changed connection pool size to 20.']);
    // The H1 heading "ADR-0001: Switch to PostgreSQL" is treated as a section heading;
    // it normalizes to a non-canonical string → goes into unmapped_headers.
    assert.deepEqual(out.unmapped_headers, ['ADR-0001: Switch to PostgreSQL']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Targeted mutation-killing tests (T2 adapter seam)
// Each test is annotated with the mutant it kills.
// ─────────────────────────────────────────────────────────────────────────────
describe('targeted: pushUnique intra-values deduplication', () => {
  // Kills: `seen.add(value)` removal mutant — without it, values-internal dups pass through.
  test('duplicate entries within the same section body are deduplicated', () => {
    const md = '## Decision\n- Same entry.\n- Same entry.\n- Different entry.';
    const out = parseAdrMarkdown(md);
    assert.deepEqual(out.decisions, ['Same entry.', 'Different entry.']);
  });
});

describe('targeted: parseSections body-split round-trip', () => {
  // Kills: body split/join mutations — each body line must be its own array element.
  // The adapter does sec.body.split('\n'); parseAdrMarkdown does section.body.join('\n').
  // A mutant replacing '\n' with ' ' in either call would break this.
  test('multi-line goal body has each line preserved with internal newlines in prose', () => {
    const md = '## Context\nLine one.\nLine two.\nLine three.';
    const out = parseAdrMarkdown(md);
    // prose = section.body.join('\n').trim() — must include all three lines separated by \n
    assert.ok(out.context.includes('Line one.'), `context missing line one: ${out.context}`);
    assert.ok(out.context.includes('Line two.'), `context missing line two: ${out.context}`);
    assert.ok(out.context.includes('Line three.'), `context missing line three: ${out.context}`);
    assert.ok(out.context.includes('\n'), 'context must retain internal newlines');
  });

  test('multi-line decision body produces one entry per non-blank line', () => {
    // entries = splitEntries(section.body.join('\n')) — join must be '\n' not ' '
    const md = '## Decision\n- Alpha.\n- Beta.\n- Gamma.';
    const out = parseAdrMarkdown(md);
    assert.deepEqual(out.decisions, ['Alpha.', 'Beta.', 'Gamma.']);
  });
});

describe('targeted: parseStatusFromSections uses first entry only', () => {
  // Kills: mutants that remove [0] indexing or change `splitEntries(...)[0]` to return all.
  test('only the first non-blank line of the status body determines status', () => {
    // Second line "rejected" must NOT influence the result.
    const md = '# ADR\n\n## Status\naccepted\nrejected\n';
    const out = parseAdrMarkdown(md);
    assert.equal(out.status, 'accepted');
  });
});

describe('targeted: classifyHeader exact-match vs prefix-match boundary', () => {
  // Kills: mutants that remove the trailing space from startsWith check, or remove
  // the equality check.

  // Case 1: exact match — heading IS the synonym (no trailing content)
  test('heading exactly equal to synonym matches (equality branch)', () => {
    const out = parseAdrMarkdown('## Status\naccepted\n');
    assert.equal(out.status, 'accepted');
  });

  // Case 2: prefix match — heading starts with synonym + space + more text
  test('heading starting with synonym + space matches (prefix branch)', () => {
    // "status of the adr" → starts with "status " → classified as status
    const out = parseAdrMarkdown('## Status of the ADR\naccepted\n');
    assert.equal(out.status, 'accepted');
  });

  // Case 3: heading IS synonym but no trailing space should NOT match via startsWith
  // (it matches via equality instead) — this verifies the equality check fires
  test('heading that exactly equals a synonym is classified without trailing space', () => {
    // "context" equals the synonym exactly — must be classified as goal
    const out = parseAdrMarkdown('## Context\nExact match context.');
    assert.equal(out.context.trim(), 'Exact match context.');
  });

  // Case 4: heading with wrong suffix (synonym+letter, no space) must NOT match prefix
  test('heading that is synonym + letter (no space) does NOT match prefix', () => {
    // "statuses" → normalizes to "statuses", not "status " prefix — unclassified
    const out = parseAdrMarkdown('## Statuses\naccepted\n');
    assert.ok(out.unmapped_headers.includes('Statuses'));
    // status should fall back to 'accepted' default (no status section found)
    assert.equal(out.status, 'accepted');
  });
});

describe('targeted: goal section prose vs entries distinction', () => {
  // The goal/context case uses `prose` (joined + trimmed multi-line text), not `entries`
  // (bullet-stripped list). Killing the `prose` variable or swapping it for `entries`
  // would strip bullet markers from context text.
  test('goal section body with bullet markers is preserved verbatim in context (prose, not entries)', () => {
    // If parser used entries instead of prose, "- with a dash" would become "with a dash".
    const md = '## Context\nThis is context.\n- with a dash item.\nMore prose.';
    const out = parseAdrMarkdown(md);
    assert.ok(out.context.includes('- with a dash item.'),
      `context should preserve bullet markers in prose: ${out.context}`);
  });
});

describe('targeted: normalizeAdrHeader non-word char removal', () => {
  // Kills: regex mutation in the [^\w\s] replacement — e.g. inverting the class
  // or changing the replacement target.
  test('parentheses in heading are stripped by non-word removal', () => {
    // "Context (v2)" normalizes to "context v2" — still matches "context" via prefix "context "
    const out = parseAdrMarkdown('## Context (v2)\nSome context here.');
    assert.equal(out.context.trim(), 'Some context here.');
  });

  test('non-word chars adjacent to word chars are stripped without inserting a space', () => {
    // "Context/Background" → [^\w\s] removes '/' → "contextbackground" (no space)
    // So it does NOT classify as goal (exact "contextbackground" ≠ any synonym).
    const out = parseAdrMarkdown('## Context/Background\nSlash context.');
    // Does not classify as goal — goes to unmapped_headers
    assert.ok(out.unmapped_headers.includes('Context/Background'));
    assert.equal(out.context, '');
  });
});

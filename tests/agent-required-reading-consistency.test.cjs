// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * GSD Agent Required Reading Consistency Tests
 *
 * Validates that all agent .md files use the standardized <required_reading>
 * pattern and that no legacy <files_to_read> blocks remain.
 *
 * See: https://github.com/open-gsd/gsd-core/issues/2168
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { listAgentFiles } = require('./helpers/agent-roster.cjs');

const AGENTS_DIR = path.join(__dirname, '..', 'agents');

// Sorted basenames (without `.md`). Every use below generates an independent
// per-agent test and reads each file via `agent + '.md'`; nothing here depends
// on registration order, so the sorted helper roster is behaviorally identical.
const ALL_AGENTS = listAgentFiles(AGENTS_DIR);

// ─── No Legacy files_to_read Blocks ────────────────────────────────────────

describe('READING: no legacy <files_to_read> blocks remain', () => {
  for (const agent of ALL_AGENTS) {
    test(`${agent} does not contain <files_to_read>`, () => {
      const content = fs.readFileSync(path.join(AGENTS_DIR, agent + '.md'), 'utf-8');
      assert.ok(
        !content.includes('<files_to_read>'),
        `${agent} still has <files_to_read> opening tag — migrate to <required_reading>`
      );
      assert.ok(
        !content.includes('</files_to_read>'),
        `${agent} still has </files_to_read> closing tag — migrate to </required_reading>`
      );
    });
  }

  test('no backtick references to files_to_read in any agent', () => {
    for (const agent of ALL_AGENTS) {
      const content = fs.readFileSync(path.join(AGENTS_DIR, agent + '.md'), 'utf-8');
      assert.ok(
        !content.includes('`<files_to_read>`'),
        `${agent} still references \`<files_to_read>\` in prose — update to \`<required_reading>\``
      );
    }
  });
});

// ─── Standardized required_reading Pattern ─────────────────────────────────

describe('READING: agents with reading blocks use <required_reading>', () => {
  // Agents that have any kind of reading instruction should use required_reading
  const AGENTS_WITH_READING = ALL_AGENTS.filter(name => {
    const content = fs.readFileSync(path.join(AGENTS_DIR, name + '.md'), 'utf-8');
    return content.includes('required_reading') || content.includes('files_to_read');
  });

  test('at least 20 agents have reading instructions', () => {
    assert.ok(
      AGENTS_WITH_READING.length >= 20,
      `Expected at least 20 agents with reading instructions, found ${AGENTS_WITH_READING.length}`
    );
  });

  for (const agent of AGENTS_WITH_READING) {
    test(`${agent} uses required_reading (not files_to_read)`, () => {
      const content = fs.readFileSync(path.join(AGENTS_DIR, agent + '.md'), 'utf-8');
      assert.ok(
        content.includes('required_reading'),
        `${agent} has reading instructions but does not use required_reading`
      );
      assert.ok(
        !content.includes('files_to_read'),
        `${agent} still uses files_to_read — must be migrated to required_reading`
      );
    });
  }
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-patterns-reference.test.cjs — consolidation epic #1969 (B8 #1977)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-patterns-reference (consolidation epic #1969 B8 #1977)", () => {
// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Common Bug Patterns Reference Tests
 *
 * Structural tests for the common-bug-patterns.md reference file:
 * - File exists at expected path
 * - Contains expected bug pattern categories (at least 5 of 10)
 * - Debugger agent references the file in required_reading
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REFERENCE_PATH = path.join(
  __dirname, '..', 'gsd-core', 'references', 'common-bug-patterns.md'
);
const DEBUGGER_AGENT_PATH = path.join(
  __dirname, '..', 'agents', 'gsd-debugger.md'
);

const EXPECTED_CATEGORIES = [
  'Off-by-One',
  'Null',
  'Async',
  'State Management',
  'Import',
  'Environment',
  'Data Shape',
  'String Handling',
  'File System',
  'Error Handling',
];

describe('common-bug-patterns.md reference', () => {
  test('reference file exists', () => {
    assert.ok(
      fs.existsSync(REFERENCE_PATH),
      `Expected reference file at ${REFERENCE_PATH}`
    );
  });

  test('has title and intro', () => {
    const content = fs.readFileSync(REFERENCE_PATH, 'utf-8');
    assert.ok(
      content.startsWith('# Common Bug Patterns'),
      'File should start with "# Common Bug Patterns" title'
    );
    assert.ok(
      content.includes('---'),
      'File should contain --- separator after intro'
    );
  });

  test('contains at least 5 of 10 expected categories', () => {
    const content = fs.readFileSync(REFERENCE_PATH, 'utf-8');
    const found = EXPECTED_CATEGORIES.filter(cat =>
      content.toLowerCase().includes(cat.toLowerCase())
    );
    assert.ok(
      found.length >= 5,
      `Expected at least 5 categories, found ${found.length}: ${found.join(', ')}`
    );
  });

  test('each pattern category has at least one bold bullet item', () => {
    const content = fs.readFileSync(REFERENCE_PATH, 'utf-8');
    // Only check sections inside <patterns> block, not <usage>
    const patternsBlock = (content.split('<patterns>')[1] || '').split('</patterns>')[0];
    const sections = patternsBlock.split(/^## /m).slice(1);
    assert.ok(sections.length >= 5, `Expected at least 5 pattern sections, got ${sections.length}`);
    for (const section of sections) {
      const title = section.split('\n')[0].trim();
      const bullets = section.match(/^- \*\*/gm);
      assert.ok(
        bullets && bullets.length >= 1,
        `Pattern section "${title}" should have at least one "- **" bullet item`
      );
    }
  });
});

describe('debugger agent references bug patterns', () => {
  test('gsd-debugger.md exists', () => {
    assert.ok(
      fs.existsSync(DEBUGGER_AGENT_PATH),
      `Expected debugger agent at ${DEBUGGER_AGENT_PATH}`
    );
  });

  test('gsd-debugger.md references common-bug-patterns.md', () => {
    const content = fs.readFileSync(DEBUGGER_AGENT_PATH, 'utf-8');
    assert.ok(
      content.includes('common-bug-patterns.md'),
      'Debugger agent should reference common-bug-patterns.md'
    );
  });

  test('reference is inside <required_reading> block', () => {
    const content = fs.readFileSync(DEBUGGER_AGENT_PATH, 'utf-8');
    const reqReadMatch = content.match(
      // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own agent .md content, fixed-size author-controlled content
      /<required_reading>([\s\S]*?)<\/required_reading>/
    );
    assert.ok(reqReadMatch, 'Debugger agent should have a <required_reading> block');
    assert.ok(
      reqReadMatch[1].includes('common-bug-patterns.md'),
      'common-bug-patterns.md should be inside <required_reading> block'
    );
  });
});
  });
}

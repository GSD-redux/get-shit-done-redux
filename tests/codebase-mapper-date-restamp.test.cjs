// allow-test-rule: source-text-is-the-product (see #2279)
// The gsd-codebase-mapper agent and map-codebase workflow .md files ARE the
// contract the model loads at runtime. Regression lock for #2279: on an Update
// run the agent must restamp the codebase-doc dates unconditionally, not merely
// substitute the [YYYY-MM-DD] placeholder (absent once a doc holds a real date).

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MAPPER = fs.readFileSync(path.join(ROOT, 'agents', 'gsd-codebase-mapper.md'), 'utf-8');
const WORKFLOW = fs.readFileSync(path.join(ROOT, 'gsd-core', 'workflows', 'map-codebase.md'), 'utf-8');

// The pre-fix framing: substitute-the-placeholder-only, which never fires on an
// Update run because the placeholder was already replaced by a concrete date.
// The two files phrased the bug differently, so each needs its own stale regex;
// a single regex asserted against both silently passes on the file it never
// matched, leaving that file's negative guard dead. map-codebase.md itself used
// two pre-fix phrasings (the four per-spawn prompts plain, the sequential
// fallback backtick-wrapped and carrying "from init context"), so its stale
// regex has to cover both or the fallback site's guard is dead for the same
// reason.
const WORKFLOW_STALE_PLACEHOLDER_ONLY =
  /Use `?\{date\}`?(?: from init context)? for all `?\[YYYY-MM-DD\]`? date placeholders/;
const MAPPER_STALE_PLACEHOLDER_ONLY = /Replace `?\[YYYY-MM-DD\]`? with the date/i;

// The fixed framing. Both files say "overwriting <any|whatever> ... date"; the
// regex stays loose on the object so a future rewording of the tail does not
// break the lock, while still requiring the overwrite verb the bug lacked.
const OVERWRITE_INSTRUCTION = /overwrit(?:e|ing)\s+(?:any|whatever)[^.\n]*date/i;
const WORKFLOW_OVERWRITE_SITE = /overwrit(?:e|ing) any existing date/gi;

describe('map-codebase date restamp (#2279)', () => {
  test('mapper instructs overwriting an existing date on update runs', () => {
    assert.match(
      MAPPER,
      OVERWRITE_INSTRUCTION,
      'gsd-codebase-mapper.md must tell the agent to overwrite a prior concrete date, not only fill [YYYY-MM-DD]',
    );
  });

  test('workflow reminder requires overwriting an existing date', () => {
    assert.match(
      WORKFLOW,
      OVERWRITE_INSTRUCTION,
      'map-codebase.md must instruct overwriting an existing date, not only [YYYY-MM-DD] placeholders',
    );
  });

  test('no date-instruction site retains the placeholder-only framing', () => {
    // Every site must carry the overwrite instruction: the per-spawn Agent()
    // prompts in spawn_agents (the primary path) regressed independently of
    // the sequential_mapping fallback, so a whole-file "fix appears somewhere"
    // match is not enough.
    assert.doesNotMatch(
      MAPPER,
      MAPPER_STALE_PLACEHOLDER_ONLY,
      'gsd-codebase-mapper.md still contains a placeholder-only date instruction',
    );
    assert.doesNotMatch(
      WORKFLOW,
      WORKFLOW_STALE_PLACEHOLDER_ONLY,
      'map-codebase.md still contains a placeholder-only date instruction',
    );
    const overwriteSites = WORKFLOW.match(WORKFLOW_OVERWRITE_SITE) ?? [];
    assert.ok(
      overwriteSites.length >= 5,
      `expected the overwrite instruction at every date-instruction site in map-codebase.md (4 per-spawn prompts + the sequential fallback), found ${overwriteSites.length}`,
    );
  });
});

// allow-test-rule: source-text-is-the-product (#1700)
// spike.md / spike-wrap-up.md / artifact-types.md / sketch.md are workflow and reference
// markdown — their text IS the contract loaded by the agent at runtime. Testing text content
// tests the deployed contract; there is no build step, CLI entrypoint, or generated code to
// exercise for this class of file (confirmed via mcp__memtrace__find_code: only .md files and
// unrelated `.planning/phases/*/REQUIREMENTS.md` symbols in gap-checker.cts/milestone.cts
// reference this seam — a different artifact family, not this one).
//
// Regression test for #1700: `.planning/spikes/MANIFEST.md` held a single un-keyed `## Idea` /
// `## Requirements` pair while its own read path (`spike.md:138`, frontier mode) assumed the
// tree holds several unrelated ideas across campaigns. `spike-wrap-up.md` then copied that flat
// Requirements list verbatim into every generated feature-area reference and the generated
// spike-findings skill, so one idea's requirements leaked into another idea's build as binding
// constraints. The fix scopes both the write side (spike.md's create_manifest) and the read/
// re-emit side (spike-wrap-up.md's gather/synthesize/write_skill) by an explicit idea key,
// carried through spike README frontmatter and a new Idea column in the `## Spikes` table.
//
// QA-matrix note: none of CONTRIBUTING.md's CLI / parser / filesystem-write / security matrices
// apply — this is a workflow-prompt template edit with no runtime code path, parser, or write
// seam of its own (the `.planning/spikes/` tree is written by an LLM agent following the
// workflow prose, not by GSD's own code). No numeric limit is introduced, so the limit-1/limit/
// limit+1 boundary-coverage rule and the fast-check property-test requirement do not apply
// either — there is no parser, budget, or bijective contract in this change. See
// `.gsd/bug/fix-1700-spike-manifest-idea-scoping/50-test-matrix.md` for the full row table.

'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');
const REFERENCES_DIR = path.join(__dirname, '..', 'gsd-core', 'references');

const spikeMd = () => fs.readFileSync(path.join(WORKFLOWS_DIR, 'spike.md'), 'utf-8');
const spikeWrapUpMd = () => fs.readFileSync(path.join(WORKFLOWS_DIR, 'spike-wrap-up.md'), 'utf-8');
const sketchMd = () => fs.readFileSync(path.join(WORKFLOWS_DIR, 'sketch.md'), 'utf-8');
const artifactTypesMd = () => fs.readFileSync(path.join(REFERENCES_DIR, 'artifact-types.md'), 'utf-8');

describe('fix-1700: spike MANIFEST.md scopes Idea/Requirements per idea key', () => {
  // Row 1 — the failing-first regression test (50-test-matrix.md row 1).
  test('spike.md create_manifest step defines an explicit idea key and a scoped ## Ideas structure', () => {
    const content = spikeMd();
    assert.match(
      content,
      /idea key/i,
      'create_manifest step must introduce an explicit "idea key" concept — without one, ' +
      'the write side has no way to tell a continuation of the current idea from an unrelated new idea (#1700).'
    );
    assert.match(
      content,
      /##\s*Ideas\b/,
      'MANIFEST.md template must have a `## Ideas` section (plural) that can hold more than one ' +
      'idea, replacing the old single flat `## Idea` paragraph.'
    );
    assert.match(
      content,
      /###\s*\{idea-key\}/,
      "MANIFEST.md template must scope each idea under its own `### {idea-key}` subsection so " +
      "idea A's paragraph is never overwritten by idea B (#1700 acceptance criterion 1)."
    );
  });

  test('create_manifest step instructs appending a new idea section instead of overwriting an existing one', () => {
    const content = spikeMd();
    assert.match(
      content,
      /new idea key[\s\S]{0,200}?append/i,
      'When the current idea is new (not a continuation), the workflow must append a new idea ' +
      'section rather than overwrite/merge into an existing one.'
    );
    assert.match(
      content,
      /[Nn]ever touch[\s\S]{0,80}?(?:another|other) idea/i,
      "The workflow must explicitly forbid touching another idea's section when adding to the current one."
    );
  });

  test("create_manifest step migrates a pre-#1700 flat-shape MANIFEST.md instead of discarding it (Hyrum's Law)", () => {
    const content = spikeMd();
    assert.match(
      content,
      /old flat[\s\S]{0,40}?shape/i,
      'The workflow must handle an existing MANIFEST.md written before this fix (flat `## Idea` / ' +
      '`## Requirements`, no `## Ideas` heading) by migrating it in place, not discarding user data.'
    );
  });

  test('## Spikes table gains an Idea column so every spike is attributable to an idea (acceptance criterion 3)', () => {
    const content = spikeMd();
    assert.match(
      content,
      /\|\s*#\s*\|\s*Idea\s*\|\s*Name\s*\|\s*Type\s*\|\s*Validates\s*\|\s*Verdict\s*\|\s*Tags\s*\|/,
      'The `## Spikes` table header must include an Idea column between # and Name, so the ' +
      'durable index still covers every spike across every idea while attributing each row.'
    );
  });

  test('spike README frontmatter template carries an idea key field', () => {
    const content = spikeMd();
    assert.match(
      content,
      /spike:\s*NNN\r?\nidea:\s*\{idea-key\}/,
      'The build_spikes README frontmatter template must record the owning idea key directly ' +
      'on the spike, so spike-wrap-up can attribute requirements without re-deriving it.'
    );
  });

  test("reground step checks the CURRENT idea's requirements, not all requirements", () => {
    const content = spikeMd();
    assert.match(
      content,
      /current idea's[\s\S]{0,80}?Requirements/i,
      'The reground step must scope its established-requirements check to the idea being spiked, ' +
      'not the whole MANIFEST.md, or it would falsely flag idea B as contradicting idea A.'
    );
  });

  test("frontier_mode load step reads every idea's scoped requirements, not one flat section", () => {
    const content = spikeMd();
    assert.match(
      content,
      /every idea section/i,
      "Frontier mode's MANIFEST.md load step must describe reading per-idea sections, matching " +
      'the new ## Ideas structure it depends on.'
    );
  });

  test("spike-wrap-up.md gather step resolves each spike's idea key before reading requirements", () => {
    const content = spikeWrapUpMd();
    assert.match(
      content,
      /idea key/i,
      "spike-wrap-up.md must resolve an idea key per spike (from frontmatter or the Spikes table) " +
      'before it can scope which Requirements apply — otherwise it still reads the whole ' +
      'MANIFEST.md Requirements section flat (#1700 root cause on the consumer side).'
    );
  });

  test("spike-wrap-up.md synthesize step scopes Requirements to the feature area's owning idea key(s)", () => {
    const content = spikeWrapUpMd();
    assert.match(
      content,
      /ONLY from the Requirements list of the idea key/,
      "The synthesize step's Requirements block must pull only from the idea key(s) that own the " +
      'spikes in that feature-area group — never the whole MANIFEST.md (#1700 acceptance criterion 2).'
    );
    assert.match(
      content,
      /[Nn]ever include a requirement from an idea key that has no spike in this group/,
      "The synthesize step must explicitly forbid leaking an unrelated idea's requirement into a " +
      'feature-area reference it has no spike in.'
    );
  });

  test("spike-wrap-up.md write_skill step unions only the wrapped idea keys' requirements", () => {
    const content = spikeWrapUpMd();
    assert.match(
      content,
      /never the whole MANIFEST\.md/,
      "The generated SKILL.md <requirements> block must be built from only the idea key(s) " +
      'represented among the spikes actually being wrapped in this session.'
    );
  });

  test('artifact-types.md no longer labels the project-level MANIFEST.md "per-spike" (acceptance criterion 4)', () => {
    const content = artifactTypesMd();
    assert.doesNotMatch(
      content,
      /MANIFEST\.md \(per-spike/,
      'artifact-types.md must not describe the project-level, durable-index MANIFEST.md as ' +
      '"per-spike" — that mislabeling is the third independent statement of the #1700 ambiguity ' +
      "the maintainer's triage flagged."
    );
    assert.match(
      content,
      /MANIFEST\.md \(per-project index/,
      'artifact-types.md must instead label MANIFEST.md as the per-project durable index.'
    );
  });

  test('artifact-types.md keeps the legacy /gsd:spike colon form untouched (out of scope, #2903)', () => {
    const content = artifactTypesMd();
    assert.match(
      content,
      /via \/gsd:spike/,
      'The colon-form command reference belongs to #2903 and must not be touched by this fix.'
    );
  });

  test('sketch.md no longer assumes spikes/MANIFEST.md has a single flat Requirements section', () => {
    const content = sketchMd();
    assert.match(
      content,
      /separate `### \{idea-key\}` sections/,
      "sketch.md reads spikes/MANIFEST.md for design constraints; once MANIFEST.md nests " +
      "Requirements under per-idea sections, sketch.md's single-section instruction goes stale " +
      'unless updated in the same PR (collateral of this fix\'s seam, not a separate concern).'
    );
  });

  test('success criteria in spike.md reflect idea-scoped requirement tracking', () => {
    const content = spikeMd();
    assert.match(
      content,
      /scoped to the idea key/,
      'spike.md success_criteria must call out that Requirements are tracked per idea key, not globally.'
    );
  });

  test('success criteria in spike-wrap-up.md forbid blending requirements across ideas', () => {
    const content = spikeWrapUpMd();
    assert.match(
      content,
      /never blended with an unrelated idea/,
      'spike-wrap-up.md success_criteria must explicitly call out that requirements must never ' +
      'blend across idea keys.'
    );
  });
});

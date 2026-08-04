/**
 * new-project workflow — MVP mode prompt contract test
 * Verifies the workflow markdown documents the Vertical MVP / Horizontal Layers
 * prompt and the ROADMAP.md template branch under MVP mode.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const WORKFLOW = path.join(__dirname, '..', 'gsd-core', 'workflows', 'new-project.md');

function parseNewProjectContract(content) {
  const lines = content.split(/\r?\n/);
  const lowerLines = lines.map(line => line.toLowerCase());
  return {
    hasVerticalMvpOption: lowerLines.some(line => line.includes('vertical mvp')),
    hasHorizontalLayersOption: lowerLines.some(line => line.includes('horizontal layers')),
    hasModeMvpTemplateLine: lowerLines.some(line => line.includes('**mode:** mvp')),
    hasHorizontalStandardFallback: lowerLines.some(line =>
      (line.includes('horizontal') && line.includes('standard')) ||
      (line.includes('standard') && line.includes('horizontal')) ||
      (line.includes('no mode line'))
    ),
  };
}

describe('new-project — MVP mode prompt', () => {
  const contract = parseNewProjectContract(fs.readFileSync(WORKFLOW, 'utf-8'));

  test('workflow includes Vertical MVP option in mode prompt', () => {
    assert.ok(contract.hasVerticalMvpOption, 'must mention Vertical MVP option');
  });

  test('workflow includes Horizontal Layers option in mode prompt', () => {
    assert.ok(contract.hasHorizontalLayersOption, 'must mention Horizontal Layers option');
  });

  test('ROADMAP template emits **Mode:** mvp under Vertical MVP path', () => {
    assert.ok(contract.hasModeMvpTemplateLine, 'must emit **Mode:** mvp on initial roadmap phases under Vertical MVP');
  });

  test('workflow falls back to standard template when Horizontal Layers picked', () => {
    assert.ok(contract.hasHorizontalStandardFallback, 'must specify fallback to standard template');
  });
});

// Bug #1516 — folded into the new-project owning module test (new top-level bug-NNNN
// files are banned by lint-regression-test-names). /gsd-new-project's two AI Models
// prompts (Step 2a auto-mode + Step 5 interactive) enumerated only 4 profiles
// (Balanced/Quality/Budget/Inherit), omitting `adaptive` even though the model catalog
// (model-catalog.json profiles) and docs/CONFIGURATION.md register 5. The fix mirrors
// the #3784 two-question split already shipped for /gsd:settings. new-project.md has no
// <step> tags, so blocks are located by the `header: "AI Models"` marker.

// #2994 fragmentization moved the Step 2a "AI Models" auto-mode prompt (and its
// config-new-project example payload) out of new-project.md into
// gsd-core/workflows/new-project/steps/auto-mode-config.md behind a section
// marker (Step 5's interactive prompt stays in the host). Read host + every
// step file combined so the "at least two AI Models prompts" / "both example
// payloads" counts are preserved across the split rather than reduced.
const NEW_PROJECT_STEPS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows', 'new-project', 'steps');
function readNewProjectCombined() {
  let combined = fs.readFileSync(WORKFLOW, 'utf8');
  if (fs.existsSync(NEW_PROJECT_STEPS_DIR)) {
    for (const entry of fs.readdirSync(NEW_PROJECT_STEPS_DIR).sort()) {
      if (entry.endsWith('.md')) {
        combined += '\n' + fs.readFileSync(path.join(NEW_PROJECT_STEPS_DIR, entry), 'utf8');
      }
    }
  }
  return combined;
}

describe('bug #1516: new-project AI Models prompt exposes all 5 model profiles', () => {
  const content = readNewProjectCombined();

  // Locate every `header: "AI Models"` AskUserQuestion block and grab a window large
  // enough to include its conditional Q2 successor (the standard-tier picker).
  function extractAiModelsBlocks(text) {
    const blocks = [];
    const headerRe = /header:\s*"AI Models"/g;
    let m;
    while ((m = headerRe.exec(text)) !== null) {
      // Window from the header to the next ``` fence (closes the AskUserQuestion code block)
      // or 60 lines, whichever comes first — captures Q1 + Q2 of the split.
      const from = m.index;
      const fenceAfter = text.indexOf('```', from + 1);
      const windowEnd = fenceAfter === -1 ? from + 60 * 80 : Math.min(fenceAfter + 3, from + 60 * 80);
      blocks.push(text.slice(from, windowEnd));
    }
    return blocks;
  }

  function labelsIn(block) {
    const out = [];
    const re = /label:\s*"([^"]+)"/g;
    let mm;
    while ((mm = re.exec(block)) !== null) out.push(mm[1].toLowerCase());
    return out;
  }

  const aiModelsBlocks = extractAiModelsBlocks(content);

  test('new-project has at least two AI Models prompts (Step 2a auto + Step 5 interactive)', () => {
    assert.ok(
      aiModelsBlocks.length >= 2,
      `expected ≥2 AI Models prompts (auto-mode + interactive), found ${aiModelsBlocks.length}`,
    );
  });

  test('each AI Models prompt makes adaptive reachable (#1516 — was omitted entirely)', () => {
    assert.ok(aiModelsBlocks.length > 0, 'must find at least one AI Models block to assert against');
    for (let i = 0; i < aiModelsBlocks.length; i++) {
      const labels = labelsIn(aiModelsBlocks[i]);
      assert.ok(
        labels.some(l => l === 'adaptive' || l.startsWith('adaptive')),
        `AI Models prompt #${i + 1} must include an "Adaptive" option (the #1516 regression — adaptive was missing). Got labels: [${labels.join(', ')}]`,
      );
    }
  });

  test('all 5 model profiles are reachable across the new-project model-selection surface', () => {
    const surface = aiModelsBlocks.join('\n');
    const labels = labelsIn(surface);
    for (const profile of ['adaptive', 'quality', 'balanced', 'budget', 'inherit']) {
      assert.ok(
        labels.some(l => l === profile || l.startsWith(profile)),
        `model profile "${profile}" must be reachable as a selectable option in the AI Models prompts. Got labels: [${labels.join(', ')}]`,
      );
    }
  });

  test('no options array in new-project.md exceeds the 4-option AskUserQuestion runtime cap', () => {
    // Guards against a naive single 5-option block (which the AskUserQuestion runtime rejects).
    const CAP = 4;
    const optionsKeyRe = /\boptions\s*:\s*\[/g;
    let match;
    let questionIndex = 0;
    let offender = null;
    while ((match = optionsKeyRe.exec(content)) !== null) {
      questionIndex++;
      let depth = 0;
      const start = match.index + match[0].length - 1;
      let end = start;
      for (let k = start; k < content.length; k++) {
        if (content[k] === '[') depth++;
        else if (content[k] === ']') { depth--; if (depth === 0) { end = k; break; } }
      }
      const optionsBody = content.slice(start, end + 1);
      const labelMatches = optionsBody.match(/label:\s*"[^"]+"/g) || [];
      if (labelMatches.length > CAP) { offender = { questionIndex, count: labelMatches.length }; break; }
    }
    assert.ok(
      !offender,
      offender
        ? `options array #${offender.questionIndex} has ${offender.count} options — exceeds the AskUserQuestion runtime cap of ${CAP}. Split into multiple questions (as #3784 did for model_profile).`
        : true,
    );
    assert.ok(questionIndex > 0, 'new-project.md must contain at least one AskUserQuestion options array');
  });

  test('both config-new-project example payloads list adaptive in the model_profile enum', () => {
    // The two example payloads (Step 2a + Step 5) hard-coded "quality|balanced|budget|inherit"
    // and must now include adaptive.
    const enumRe = /model_profile"\s*:\s*"([^"]*)"/g;
    let match;
    const enums = [];
    while ((match = enumRe.exec(content)) !== null) {
      enums.push(match[1]);
    }
    assert.ok(enums.length >= 2, `expected >=2 config-new-project example payloads, found ${enums.length}`);
    for (let i = 0; i < enums.length; i++) {
      assert.ok(
        enums[i].includes('adaptive'),
        `config-new-project example payload #${i + 1} model_profile enum must include "adaptive". Got: "${enums[i]}"`,
      );
    }
  });

  test('new-project.md has balanced braces (regression guard, mirrors #3784 bd53925f)', () => {
    let depth = 0;
    for (const ch of content) {
      if (ch === '{') depth++;
      if (ch === '}') depth--;
    }
    assert.strictEqual(depth, 0, `new-project.md has unbalanced braces: net depth ${depth}`);
  });
});

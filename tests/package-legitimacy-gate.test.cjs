'use strict';

/**
 * Package Legitimacy Gate — structural contract tests (#2827)
 *
 * Verifies that the three agents (researcher, planner, executor) contain the
 * interlocking instruction text that forms the slopsquatting defence gate.
 *
 * The gate spans TWO layers. The executor stops at a `gate="blocking-human"`
 * checkpoint and hands it up; the execute-phase orchestrator then decides
 * whether the human ever sees it. Asserting only the executor half leaves the
 * orchestrator free to auto-approve the checkpoint the executor just refused
 * to auto-approve.
 */

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const AGENTS = path.join(__dirname, '..', 'agents');
const RESEARCHER = path.join(AGENTS, 'gsd-phase-researcher.md');
const PLANNER = path.join(AGENTS, 'gsd-planner.md');
const EXECUTOR = path.join(AGENTS, 'gsd-executor.md');

const WORKFLOWS = path.join(__dirname, '..', 'gsd-core', 'workflows');
const EXECUTE_PHASE = path.join(WORKFLOWS, 'execute-phase.md');

function parseSections(md) {
  const lines = md.split(/\r?\n/);
  const sections = [];
  let current = { heading: '__preamble__', body: [] };
  let inFence = false;

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) inFence = !inFence;
    if (!inFence && /^#{1,3} /.test(line)) {
      sections.push(current);
      current = { heading: line.replace(/^#+\s*/, '').trim(), body: [] };
      continue;
    }
    current.body.push(line);
  }

  sections.push(current);
  return sections;
}

function extractCodeBlocks(text) {
  const blocks = [];
  const lines = text.split(/\r?\n/);
  let inside = false;
  let buf = [];

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      if (inside) {
        blocks.push(buf.join('\n'));
        buf = [];
      }
      inside = !inside;
      continue;
    }
    if (inside) buf.push(line);
  }

  return blocks;
}

function extractResearchTemplate(content) {
  const lines = content.split(/\r?\n/);
  let inside = false;
  let isMarkdownFence = false;
  let buf = [];

  for (const line of lines) {
    if (!inside && line.startsWith('```markdown')) {
      inside = true;
      isMarkdownFence = true;
      buf = [];
      continue;
    }

    if (inside && line.startsWith('```') && isMarkdownFence) {
      const candidate = buf.join('\n');
      if (/^\s*#\s+Phase\b/m.test(candidate)) return candidate;
      inside = false;
      isMarkdownFence = false;
      continue;
    }

    if (inside) buf.push(line);
  }

  return '';
}

function extractPlanTemplate(content) {
  const blocks = extractCodeBlocks(content);
  for (const block of blocks) {
    if (/^\s*<threat_model>/m.test(block)) return block;
  }
  return '';
}

function extractXmlElement(text, tag) {
  const start = text.indexOf(`<${tag}>`);
  const end = text.indexOf(`</${tag}>`);
  if (start === -1 || end === -1) return '';
  return text.slice(start, end + tag.length + 3);
}

// Structural RULE locator (#3426): anchor on the `**RULE N:**` heading inside
// <deviation_rules> — never on incidental word proximity elsewhere in the file,
// which let unrelated edits re-anchor the old first-token-scan-hit window.
// Returns { heading, lines } for the section spanning the heading up to (not
// including) the next `**RULE N:**` heading, or null when <deviation_rules> is
// missing or the requested rule has zero or duplicated headings.
function extractRuleSection(text, ruleNumber) {
  const block = extractXmlElement(text, 'deviation_rules');
  if (!block) return null;
  const lines = block.split(/\r?\n/);
  const headingRe = /^\*\*RULE (\d+):/;
  const headings = lines
    .map((line, i) => ({ rule: Number((line.match(headingRe) || [])[1]), lineIndex: i }))
    .filter((h) => Number.isInteger(h.rule));
  const starts = headings.filter((h) => h.rule === ruleNumber);
  if (starts.length !== 1) return null;
  const start = starts[0].lineIndex;
  const next = headings.find((h) => h.lineIndex > start);
  const end = next ? next.lineIndex : lines.length;
  return { heading: lines[start], lines: lines.slice(start, end) };
}

function normalizeTokens(text) {
  return text
    .toLowerCase()
    .replace(/https?:\/\//g, ' ')
    .replace(/[[\]]/g, '')
    .replace(/[^a-z0-9{}:_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function hasAllTokens(text, required) {
  const tokenSet = new Set(normalizeTokens(text));
  return required.every((token) => tokenSet.has(token.toLowerCase()));
}

function anyLineHasAll(lines, required) {
  return lines.some((line) => hasAllTokens(line, required));
}

function parseMarkdownTable(lines) {
  const tableLines = lines.filter((line) => /^\s*\|/.test(line));
  if (tableLines.length < 2) return null;

  const toCells = (line) => line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

  const headers = toCells(tableLines[0]);
  const rows = tableLines
    .slice(2)
    .map(toCells)
    .filter((cells) => cells.length === headers.length)
    .map((cells) => ({
      cells,
      fields: Object.fromEntries(headers.map((h, i) => [h, cells[i]])),
    }));

  return { headers, rows };
}

function parseMarkdownTables(lines) {
  const groups = [];
  let current = [];

  for (const line of lines) {
    if (/^\s*\|/.test(line)) {
      current.push(line);
      continue;
    }
    if (current.length > 0) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length > 0) groups.push(current);

  return groups
    .map((group) => parseMarkdownTable(group))
    .filter(Boolean);
}

function lineIndexes(lines, predicate) {
  const indexes = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (predicate(lines[i], i)) indexes.push(i);
  }
  return indexes;
}

function inNearbyWindow(sourceIndexes, targetIndexes, distance) {
  return sourceIndexes.some((src) => targetIndexes.some((dst) => Math.abs(src - dst) <= distance));
}

function readModel(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  return {
    text,
    lines: text.split(/\r?\n/),
    sections: parseSections(text),
    codeBlocks: extractCodeBlocks(text),
  };
}

// allow-test-rule: source-text-is-the-product
// Agent .md files — their text IS what the runtime loads.
// Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

describe('gsd-phase-researcher.md — package-legitimacy seam invocation', () => {
  let model;

  before(() => {
    model = readModel(RESEARCHER);
  });

  test('invokes gsd-tools query package-legitimacy check inside a fenced code block', () => {
    const found = model.codeBlocks.some((block) =>
      hasAllTokens(block, ['package-legitimacy', 'check'])
    );
    assert.ok(found, 'researcher must invoke package-legitimacy check inside a fenced code block');
  });

  test('package-legitimacy invocation includes --ecosystem flag', () => {
    const found = model.codeBlocks.some((block) =>
      hasAllTokens(block, ['package-legitimacy', 'check']) && hasAllTokens(block, ['--ecosystem'])
    );
    assert.ok(found, 'package-legitimacy check must include --ecosystem flag');
  });

  test('documents SLOP, SUS, OK verdict interpretation', () => {
    const hasSLOP = anyLineHasAll(model.lines, ['slop']);
    const hasSUS = anyLineHasAll(model.lines, ['sus']);
    const hasOK = anyLineHasAll(model.lines, ['ok']);
    assert.ok(hasSLOP && hasSUS && hasOK, 'researcher must document SLOP, SUS, OK verdict interpretation');
  });

  test('documents [ASSUMED] tag for WebSearch-discovered packages not verified against authoritative source', () => {
    const hasAssumedLine = anyLineHasAll(model.lines, ['assumed']);
    const hasWebSearchOrTraining = model.lines.some((line) =>
      hasAllTokens(line, ['websearch']) || hasAllTokens(line, ['training'])
    );
    assert.ok(
      hasAssumedLine && hasWebSearchOrTraining,
      'researcher must document [ASSUMED] tag for packages from non-authoritative sources'
    );
  });
});

describe('gsd-phase-researcher.md — Package Legitimacy Audit section in template', () => {
  let templateSections;

  before(() => {
    const model = readModel(RESEARCHER);
    const template = extractResearchTemplate(model.text);
    templateSections = parseSections(template);
  });

  test('RESEARCH.md template contains Package Legitimacy Audit section', () => {
    const section = templateSections.find((s) => s.heading === 'Package Legitimacy Audit');
    assert.ok(section, 'RESEARCH.md template must include a Package Legitimacy Audit section');
  });

  test('Package Legitimacy Audit table has required columns', () => {
    const section = templateSections.find((s) => s.heading === 'Package Legitimacy Audit');
    assert.ok(section, 'Package Legitimacy Audit section must exist');

    const table = parseMarkdownTable(section.body);
    assert.ok(table, 'Package Legitimacy Audit section must include a markdown table');

    // 'slopcheck' column renamed to 'Verdict' to reflect the code seam (gsd-tools query package-legitimacy)
    const expected = ['Package', 'Registry', 'Age', 'Downloads', 'Verdict', 'Disposition'];
    for (const column of expected) {
      assert.ok(table.headers.includes(column), `audit table must have "${column}" column`);
    }
  });

  test('audit section documents [SLOP], [SUS], and [OK] dispositions', () => {
    const section = templateSections.find((s) => s.heading === 'Package Legitimacy Audit');
    assert.ok(section, 'Package Legitimacy Audit section must exist');

    const table = parseMarkdownTable(section.body);
    assert.ok(table, 'Package Legitimacy Audit section must include a markdown table');

    const rowTexts = table.rows.map((row) => row.cells.join(' '));
    const slop = rowTexts.some((value) => hasAllTokens(value, ['slop']));
    const sus = rowTexts.some((value) => hasAllTokens(value, ['sus']));
    const ok = rowTexts.some((value) => hasAllTokens(value, ['ok']));

    assert.ok(slop, 'audit section must document [SLOP] disposition');
    assert.ok(sus, 'audit section must document [SUS] disposition');
    assert.ok(ok, 'audit section must document [OK] disposition');
  });
});

describe('gsd-phase-researcher.md — ecosystem-specific package verification', () => {
  let model;

  before(() => {
    model = readModel(RESEARCHER);
  });

  test('documents pip index versions for Python phases', () => {
    assert.ok(anyLineHasAll(model.lines, ['pip', 'index', 'versions']), 'researcher must document pip index versions');
  });

  test('documents cargo search for Rust phases', () => {
    assert.ok(anyLineHasAll(model.lines, ['cargo', 'search']), 'researcher must document cargo search');
  });
});

describe('gsd-phase-researcher.md — no npx --yes auto-download', () => {
  let model;

  before(() => {
    model = readModel(RESEARCHER);
  });

  test('does not invoke npx --yes inside a code block', () => {
    const found = model.codeBlocks.some((block) => hasAllTokens(block, ['npx', '--yes']));
    assert.equal(found, false, 'researcher must not invoke npx --yes in any code block');
  });

  test('context7 is accessed via mcp__context7__ tools (not raw CLI)', () => {
    // The research-plan seam routes context7 queries; the agent calls MCP tools directly.
    // Verify the provider table references mcp__context7__ rather than a raw ctx7 CLI invocation.
    const hasMcpContext7 = anyLineHasAll(model.lines, ['mcp__context7__']);
    assert.ok(hasMcpContext7, 'researcher must reference mcp__context7__ tools for context7 access');
  });
});

describe('gsd-phase-researcher.md — WebSearch-origin package tagging', () => {
  let model;

  before(() => {
    model = readModel(RESEARCHER);
  });

  test('packages discovered via WebSearch are tagged [ASSUMED]', () => {
    const webSearchLines = lineIndexes(model.lines, (line) => hasAllTokens(line, ['websearch']));
    const assumedLines = lineIndexes(model.lines, (line) => hasAllTokens(line, ['assumed']));

    assert.ok(webSearchLines.length > 0, 'researcher file must mention WebSearch');
    assert.ok(assumedLines.length > 0, 'researcher file must mention [ASSUMED]');
    assert.ok(
      inNearbyWindow(webSearchLines, assumedLines, 25),
      'researcher must instruct WebSearch-discovered packages are tagged [ASSUMED] in nearby guidance'
    );
  });
});

describe('gsd-planner.md — checkpoint gate for [ASSUMED]/[SUS] packages', () => {
  let model;

  before(() => {
    model = readModel(PLANNER);
  });

  test('checkpoint:human-verify guidance references [ASSUMED] and [SUS]', () => {
    const hasCheckpoint = anyLineHasAll(model.lines, ['checkpoint:human-verify']);
    const hasAssumed = anyLineHasAll(model.lines, ['assumed']);
    const hasSus = anyLineHasAll(model.lines, ['sus']);

    assert.ok(hasCheckpoint && hasAssumed, 'planner must gate [ASSUMED] packages behind checkpoint:human-verify');
    assert.ok(hasCheckpoint && hasSus, 'planner must gate [SUS] packages behind checkpoint:human-verify');
  });

  test('package-legitimacy checkpoint uses blocking-human gate and non-auto-approvable language', () => {
    const hasBlockingHumanGate = anyLineHasAll(model.lines, ['checkpoint:human-verify', 'blocking-human']);
    const hasNeverAutoApproveRule = model.lines.some((line) =>
      hasAllTokens(line, ['never', 'auto-approvable']) ||
      hasAllTokens(line, ['never', 'auto', 'approvable'])
    );

    assert.ok(hasBlockingHumanGate, 'planner legitimacy checkpoint must use gate="blocking-human"');
    assert.ok(hasNeverAutoApproveRule, 'planner must state legitimacy checkpoints are never auto-approvable');
  });

  test('package verification checkpoint includes registry URL guidance', () => {
    const hasRegistryGuidance = model.lines.some((line) =>
      hasAllTokens(line, ['npmjs', 'package']) ||
      hasAllTokens(line, ['pypi', 'project']) ||
      hasAllTokens(line, ['crates', 'crates'])
    );

    assert.ok(hasRegistryGuidance, 'planner package-verify checkpoint must include registry URL examples');
  });
});

describe('gsd-planner.md — supply-chain row in threat_model template', () => {
  let planTemplate;
  let threatModelBlock;

  before(() => {
    const model = readModel(PLANNER);
    planTemplate = extractPlanTemplate(model.text);
    threatModelBlock = extractXmlElement(planTemplate, 'threat_model');
  });

  test('PLAN.md template contains threat_model element', () => {
    assert.ok(/^\s*<threat_model>/m.test(planTemplate), 'PLAN.md template must include <threat_model>');
  });

  test('threat_model template includes supply-chain row with mitigate disposition', () => {
    const tables = parseMarkdownTables(threatModelBlock.split(/\r?\n/));
    const strideTable = tables.find((table) => table.headers.includes('Threat ID'));
    assert.ok(strideTable, 'threat_model must include STRIDE threat register table');

    const supplyChainRow = strideTable.rows.find((row) => hasAllTokens(row.cells[0] || '', ['t-{phase}-sc']));
    assert.ok(supplyChainRow, 'threat_model must include T-{phase}-SC supply-chain row');

    const dispoIdx = strideTable.headers.findIndex((h) => /disposition/i.test(String(h)));
    assert.ok(dispoIdx >= 0, 'STRIDE table must have a Disposition column');
    const disposition = supplyChainRow.cells[dispoIdx] || '';
    assert.ok(hasAllTokens(disposition, ['mitigate']), 'supply-chain threat disposition must be mitigate');
  });
});

describe('gsd-planner.md — no npx --yes auto-download', () => {
  test('does not invoke npx --yes inside a code block', () => {
    const model = readModel(PLANNER);
    const found = model.codeBlocks.some((block) => hasAllTokens(block, ['npx', '--yes']));
    assert.equal(found, false, 'planner must not invoke npx --yes in any code block');
  });
});

describe('gsd-executor.md — package installs excluded from RULE 3 auto-fix', () => {
  let model;

  before(() => {
    model = readModel(EXECUTOR);
  });

  test('does not invoke npx --yes inside a code block', () => {
    const found = model.codeBlocks.some((block) => hasAllTokens(block, ['npx', '--yes']));
    assert.equal(found, false, 'executor must not invoke npx --yes in any code block');
  });

  test('RULE 3 section explicitly excludes package-manager installs', () => {
    const section = extractRuleSection(model.text, 3);
    assert.ok(section, 'executor must contain exactly one RULE 3 section inside <deviation_rules>');

    const window = section.lines;

    const hasInstallCommands =
      anyLineHasAll(window, ['npm', 'install']) ||
      anyLineHasAll(window, ['pip', 'install']) ||
      anyLineHasAll(window, ['cargo', 'add']);

    const hasExclusionLanguage =
      anyLineHasAll(window, ['excluded']) ||
      anyLineHasAll(window, ['not', 'auto-fixable']) ||
      anyLineHasAll(window, ['do', 'not']);

    assert.ok(hasInstallCommands && hasExclusionLanguage, 'RULE 3 must explicitly exclude package-manager installs');
  });

  test('failed package installs surface checkpoint:human-verify', () => {
    const section = extractRuleSection(model.text, 3);
    assert.ok(section, 'executor must contain exactly one RULE 3 section inside <deviation_rules>');

    const window = section.lines;
    const hasFailureLanguage =
      anyLineHasAll(window, ['failed', 'install']) ||
      anyLineHasAll(window, ['install', 'fails']) ||
      anyLineHasAll(window, ['install', 'failed']);

    const hasCheckpoint = anyLineHasAll(window, ['checkpoint:human-verify']);

    assert.ok(
      hasFailureLanguage && hasCheckpoint,
      'executor must emit checkpoint:human-verify when package install fails'
    );
  });

  // #3426: the RULE 3 tests must anchor on the `**RULE N:**` heading inside
  // <deviation_rules>, never on incidental word proximity — a decoy line
  // elsewhere in the file used to silently re-anchor the old token scan
  // (first line containing both `rule` and `3` tokens), so unrelated edits
  // could redirect or defeat the guardrail assertions.
  test('RULE 3 locator anchors on the heading, not word proximity (#3426)', () => {
    const fixture = [
      '## Unrelated guidance',
      'Apply each Rule in order: (1) fix bugs, (2) add tests, (3) verify.',
      '',
      '<deviation_rules>',
      'Deviation Rule 3 applies only after steps (1) and (2) are exhausted.',
      '',
      '**RULE 1: Auto-fix bugs**',
      '',
      '---',
      '',
      '**RULE 3: Auto-fix blocking issues**',
      '',
      '**EXCLUDED from RULE 3 — package manager installs:**',
      'Running `npm install <pkg>` is **NOT** auto-fixable.',
      'If a referenced package fails to install, return a `checkpoint:human-verify` task.',
      '',
      '---',
      '',
      '**RULE 4: Ask about architectural changes**',
      '',
      '</deviation_rules>',
    ].join('\n');
    const fixtureLines = fixture.split('\n');

    // Documents the #3390 failure mode: the pre-#3426 token scan anchors on
    // the decoy numbered list above the real heading (index 1, not 10).
    const legacyAnchor = lineIndexes(fixtureLines, (line) => hasAllTokens(line, ['rule', '3']))[0];
    assert.equal(legacyAnchor, 1, 'token-scan locator is expected to hit the decoy line');

    const section = extractRuleSection(fixture, 3);
    assert.ok(section, 'structural locator must find RULE 3 inside <deviation_rules> despite decoys');
    assert.match(section.heading, /^\*\*RULE 3:/);
    assert.equal(
      section.lines.includes(fixtureLines[1]),
      false,
      'structural window must not include the out-of-block decoy line'
    );
    assert.ok(
      anyLineHasAll(section.lines, ['checkpoint:human-verify']),
      'structural window must cover the real RULE 3 content'
    );

    // Missing rule (0 heading matches) and duplicated rule (2 matches) must
    // both fail loudly rather than anchor on a guess.
    assert.equal(extractRuleSection(fixture, 2), null, 'missing rule must return null');
    assert.equal(
      extractRuleSection(fixture.replace('</deviation_rules>', '**RULE 3: Duplicate**\n\n</deviation_rules>'), 3),
      null,
      'duplicated rule heading must return null'
    );
    assert.equal(extractRuleSection(fixture.replace('<deviation_rules>', '<other>'), 3), null, 'missing <deviation_rules> must return null');
  });

  test('auto mode does not auto-approve package-legitimacy checkpoints', () => {
    const autoModeLine = lineIndexes(model.lines, (line) => hasAllTokens(line, ['auto-mode', 'checkpoint', 'behavior']))[0];
    assert.notEqual(autoModeLine, undefined, 'executor must define auto-mode checkpoint behavior');

    const window = model.lines.slice(autoModeLine, autoModeLine + 25);

    const hasExceptionRule =
      anyLineHasAll(window, ['except', 'package-legitimacy', 'checkpoints']) ||
      anyLineHasAll(window, ['do', 'not', 'auto-approve']) ||
      anyLineHasAll(window, ['blocking-human']);

    assert.ok(
      hasExceptionRule,
      'executor auto mode must explicitly block auto-approval for package-legitimacy checkpoints'
    );
  });

  // #2107 harm, one checkpoint type over: the executor auto-resolves a decision
  // checkpoint itself (auto-selects the first option and continues) without ever
  // returning it, so a blocking-human decision must be carved out HERE — the
  // orchestrator's carve-out never runs for a checkpoint the executor swallowed.
  test('auto mode does not auto-select a blocking-human decision checkpoint', () => {
    const autoModeLine = lineIndexes(model.lines, (line) => hasAllTokens(line, ['auto-mode', 'checkpoint', 'behavior']))[0];
    assert.notEqual(autoModeLine, undefined, 'executor must define auto-mode checkpoint behavior');

    const window = model.lines.slice(autoModeLine, autoModeLine + 25);

    const decisionLines = window.filter((line) => hasAllTokens(line, ['checkpoint:decision']));
    assert.ok(decisionLines.length > 0, 'executor auto-mode must document the checkpoint:decision branch');

    const gatesDecision = decisionLines.some(
      (line) =>
        hasAllTokens(line, ['blocking-human']) &&
        (hasAllTokens(line, ['stop']) || hasAllTokens(line, ['not', 'auto-select']))
    );

    assert.ok(
      gatesDecision,
      'checkpoint:decision must carve out gate="blocking-human" (STOP + return) instead of auto-selecting the first option'
    );
  });

  test('checkpoint_return_format transports the gate across the executor→orchestrator boundary', () => {
    const fmt = extractXmlElement(model.text, 'checkpoint_return_format');
    assert.ok(fmt.length > 0, 'executor must define checkpoint_return_format');

    const fmtLines = fmt.split(/\r?\n/);
    const hasGateField = fmtLines.some((line) => hasAllTokens(line, ['gate:', 'blocking-human']));

    assert.ok(
      hasGateField,
      'checkpoint_return_format must carry a **Gate:** field so blocking-human reaches the orchestrator carve-out'
    );
  });
});

describe('execute-phase.md — orchestrator honors the blocking-human gate', () => {
  let model;

  before(() => {
    model = readModel(EXECUTE_PHASE);
  });

  // The executor refuses to auto-approve a gate="blocking-human" checkpoint and
  // returns it via checkpoint_return_format. The orchestrator's auto-mode branch
  // is what runs next. If that branch dispatches purely on checkpoint *type*, it
  // auto-approves the checkpoint the executor just escalated — nullifying the
  // slopsquatting gate in exactly the unattended mode where it matters.
  test('auto-mode checkpoint handling excludes blocking-human checkpoints', () => {
    // NB: normalizeTokens keeps ':' as a word character, so the heading
    // "**Auto-mode checkpoint handling:**" yields the token `handling:`, not
    // `handling`. Anchor on the two tokens that survive intact.
    const autoModeLine = lineIndexes(model.lines, (line) =>
      hasAllTokens(line, ['auto-mode', 'checkpoint'])
    )[0];

    assert.notEqual(
      autoModeLine,
      undefined,
      'execute-phase.md must define auto-mode checkpoint handling'
    );

    const window = model.lines.slice(autoModeLine, autoModeLine + 20);

    const honorsGate =
      anyLineHasAll(window, ['blocking-human']) ||
      anyLineHasAll(window, ['except', 'package-legitimacy']);

    assert.ok(
      honorsGate,
      'execute-phase auto-mode must not auto-approve gate="blocking-human" checkpoints — ' +
        'the executor escalates them precisely so a human sees them'
    );
  });

  test('auto-approve rule for human-verify is conditional, not unconditional', () => {
    const autoApproveLines = lineIndexes(model.lines, (line) =>
      hasAllTokens(line, ['human-verify', 'auto-spawn', 'approved'])
    );

    assert.ok(
      autoApproveLines.length > 0,
      'anchor drift: no human-verify auto-approve line matched — the conditional carve-out would pass vacuously'
    );

    for (const idx of autoApproveLines) {
      const line = model.lines[idx];
      const isConditional =
        hasAllTokens(line, ['unless']) ||
        hasAllTokens(line, ['except']) ||
        hasAllTokens(line, ['blocking-human']) ||
        hasAllTokens(line, ['if', 'not']);

      assert.ok(
        isConditional,
        `execute-phase.md:${idx + 1} auto-approves human-verify unconditionally; ` +
          'it must carve out gate="blocking-human"'
      );
    }
  });

  test('auto-select rule for decision is conditional, not unconditional', () => {
    const autoSelectLines = lineIndexes(model.lines, (line) =>
      hasAllTokens(line, ['decision', 'auto-spawn', 'first', 'option'])
    );

    assert.ok(
      autoSelectLines.length > 0,
      'anchor drift: no decision auto-select line matched — the conditional carve-out would pass vacuously'
    );

    for (const idx of autoSelectLines) {
      const line = model.lines[idx];
      const isConditional =
        hasAllTokens(line, ['unless']) ||
        hasAllTokens(line, ['except']) ||
        hasAllTokens(line, ['blocking-human']) ||
        hasAllTokens(line, ['if', 'not']);

      assert.ok(
        isConditional,
        `execute-phase.md:${idx + 1} auto-selects a decision unconditionally; ` +
          'it must carve out gate="blocking-human"'
      );
    }
  });
});

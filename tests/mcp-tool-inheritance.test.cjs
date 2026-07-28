// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('MCP tool usage in GSD agents', () => {
  const agentFiles = [
    path.join(__dirname, '..', 'agents', 'gsd-executor.md'),
    path.join(__dirname, '..', 'agents', 'gsd-planner.md'),
  ];

  for (const agentFile of agentFiles) {
    const name = path.basename(agentFile);

    test(`${name} mentions MCP tool usage`, () => {
      const content = fs.readFileSync(agentFile, 'utf-8');
      const hasMcpGuidance =
        content.toLowerCase().includes('mcp') ||
        content.includes('context7') ||
        content.includes('available tools') ||
        content.includes('MCP tool');
      assert.ok(hasMcpGuidance, `${name} should mention MCP tool availability/usage`);
    });
  }

  test('gsd-executor.md explicitly instructs to use available MCP tools', () => {
    const content = fs.readFileSync(agentFiles[0], 'utf-8');
    assert.ok(
      content.includes('MCP') || content.includes('mcp__'),
      'executor should reference MCP tools'
    );
  });
});

// Regression (#657 Phase C.2): researcher agents declare mcp__tavily/ref/jina alongside
// the pre-existing mcp__exa/firecrawl tools. All six use the same generic MCP passthrough
// on every runtime (no explicit registry mapping needed until io.github.* IDs are confirmed).
describe('Researcher agents declare mcp__tavily/ref/jina tools (#657)', () => {
  const researcherAgents = [
    path.join(__dirname, '..', 'agents', 'gsd-project-researcher.md'),
    path.join(__dirname, '..', 'agents', 'gsd-phase-researcher.md'),
    path.join(__dirname, '..', 'agents', 'gsd-ui-researcher.md'),
  ];

  // Tools that must appear in the tools: frontmatter line of every researcher agent
  const requiredMcpTools = [
    'mcp__context7__*',
    'mcp__exa__*',
    'mcp__firecrawl__*',
    'mcp__tavily__*',
    'mcp__ref__*',
    'mcp__jina__*',
  ];

  for (const agentFile of researcherAgents) {
    const name = path.basename(agentFile);
    const content = fs.readFileSync(agentFile, 'utf-8');

    // Extract the tools: frontmatter line (single-line CSV form)
    const toolsLineMatch = content.match(/^tools:\s*(.+)$/m);

    test(`${name} has a tools: frontmatter line`, () => {
      assert.ok(toolsLineMatch, `${name} must have a tools: frontmatter line`);
    });

    for (const tool of requiredMcpTools) {
      test(`${name} declares ${tool}`, () => {
        assert.ok(
          toolsLineMatch && toolsLineMatch[1].includes(tool),
          `${name} tools: line must include ${tool}`
        );
      });
    }
  }
});

// Parity assertion: mcp__tavily/ref/jina must be declared alongside mcp__exa/firecrawl
// in every researcher agent. This test fails when the two sets diverge (#657 generative-fix).
describe('Researcher agent MCP tool set parity: new tools match exa/firecrawl pattern (#657)', () => {
  const researcherAgents = [
    path.join(__dirname, '..', 'agents', 'gsd-project-researcher.md'),
    path.join(__dirname, '..', 'agents', 'gsd-phase-researcher.md'),
    path.join(__dirname, '..', 'agents', 'gsd-ui-researcher.md'),
  ];

  for (const agentFile of researcherAgents) {
    const name = path.basename(agentFile);
    const content = fs.readFileSync(agentFile, 'utf-8');
    const toolsLineMatch = content.match(/^tools:\s*(.+)$/m);
    const toolsLine = toolsLineMatch ? toolsLineMatch[1] : '';

    test(`${name}: mcp__tavily__* co-declared with mcp__exa__*`, () => {
      const hasExa = toolsLine.includes('mcp__exa__*');
      const hasTavily = toolsLine.includes('mcp__tavily__*');
      assert.strictEqual(hasExa, hasTavily,
        `${name}: mcp__exa__* and mcp__tavily__* must both be present or both absent`);
    });

    test(`${name}: mcp__jina__* co-declared with mcp__firecrawl__*`, () => {
      const hasFirecrawl = toolsLine.includes('mcp__firecrawl__*');
      const hasJina = toolsLine.includes('mcp__jina__*');
      assert.strictEqual(hasFirecrawl, hasJina,
        `${name}: mcp__firecrawl__* and mcp__jina__* must both be present or both absent`);
    });

    test(`${name}: mcp__ref__* present (standalone research tool)`, () => {
      assert.ok(
        toolsLine.includes('mcp__ref__*'),
        `${name}: mcp__ref__* must be declared`
      );
    });
  }
});

// --- Regression (#1284): every MCP-backed provider named in the Step-C
// dispatch table must be granted in the agent's frontmatter `tools:` line.
// Guards against a provider being added to the waterfall + dispatch table
// without the matching mcp__<server>__* grant (the perplexity drift). ---
describe('researcher Step-C dispatch ↔ tools frontmatter parity (#1284)', () => {
  const RESEARCHERS = ['gsd-phase-researcher', 'gsd-project-researcher'];

  function mcpServersIn(text) {
    const servers = new Set();
    const re = /mcp__([a-z0-9]+)__/gi;
    let m;
    while ((m = re.exec(text)) !== null) servers.add(m[1].toLowerCase());
    return servers;
  }
  function readAgent(name) {
    return fs.readFileSync(path.join(__dirname, '..', 'agents', `${name}.md`), 'utf8');
  }
  function toolsLine(content) {
    const m = content.match(/^tools:\s*(.+)$/m);
    assert.ok(m, 'agent frontmatter must have a tools: line');
    return m[1];
  }
  function stepCTableRows(content) {
    const start = content.indexOf('### Step C');
    assert.ok(start !== -1, 'agent must have a "### Step C" dispatch section');
    const rest = content.slice(start + 1);
    const nextHeading = rest.indexOf('\n### ');
    const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
    // Only the markdown dispatch-table rows (| provider | mcp tool |) define
    // provider->tool mappings. Generic fallback prose (e.g. `mcp__<provider>__*`)
    // is intentionally excluded so it cannot create false positives.
    return section
      .split('\n')
      .filter((line) => line.trimStart().startsWith('|'))
      .join('\n');
  }

  for (const name of RESEARCHERS) {
    test(`${name}: grants mcp__<server>__* for every MCP provider in its Step-C table`, () => {
      const content = readAgent(name);
      const granted = mcpServersIn(toolsLine(content));
      const referenced = mcpServersIn(stepCTableRows(content));
      assert.ok(referenced.size > 0,
        `${name} Step-C table should reference at least one mcp__ provider`);
      const missing = [...referenced].filter((srv) => !granted.has(srv));
      assert.deepStrictEqual(missing, [],
        `${name}: Step-C references MCP provider(s) not granted in tools: frontmatter: ` +
        `${missing.join(', ')}. Add mcp__<server>__* to the profile in ` +
        `scripts/research-profiles.cjs and regenerate.`);
    });
  }
});

// --- Regression (#2526): the generalization of the #1284 check above, applied
// to EVERY agent and its WHOLE body rather than two researchers and one table.
//
// gsd-ui-auditor declared `tools: Read, Write, Bash, Grep, Glob, Skill` — no
// mcp__* grant of any kind — while its body presented a
// <playwright_mcp_approach> block as the *preferred* capture path. That branch
// was unreachable by construction: the availability check had a fixed answer,
// the three mcp__playwright__* calls could never dispatch, and the "when
// Playwright-MCP is NOT available" fallback was the only branch that ever ran.
//
// Frontmatter is read through the canonical parser (gsd-core/bin/lib/
// frontmatter.cjs), not a hand-rolled scan, so every valid YAML shape —
// inline CSV, block sequence, flow array, quoted scalar, commented-out key —
// is handled by construction rather than by accumulating regex special cases.
//
// Deliberate scope boundaries (each keeps the check honest rather than merely
// broad; every one is exercised by the negative controls below):
//   * The scanned surface is the BODY plus the frontmatter `description`, which
//     ships and is read by the dispatcher. The rest of the frontmatter is not
//     scanned: `tools:` is the grant list itself and would self-reference.
//   * SERVER-level, not exact-tool. A `mcp__playwright__navigate` grant counts
//     as granting the `playwright` server. The bug class here is a server with
//     ZERO grants; asserting exact tool names is a stricter, separate invariant.
//   * A body reference must carry the trailing `__` of a real tool name
//     (`mcp__playwright__navigate`). Bare prose naming a server is not an
//     invocation and is not flagged.
//   * A single-character server id is a prose metavariable, not a reference:
//     gsd-phase-researcher legitimately writes "for any other provider id `X`
//     ... use `mcp__X__*`". Real server ids are longer. (Same false-positive
//     hazard #1284 avoids by scoping to table rows.)
//     A MULTI-character placeholder is spelled `mcp__<SERVER>__*` — the
//     angle-bracket form is the sanctioned convention, and it is exempt by
//     construction because `<` lies outside REFERENCE_RE's character class.
//     `mcp__SERVER__*` is deliberately NOT exempt: an all-caps escape hatch
//     would be a false NEGATIVE for any real server that happens to be spelled
//     in caps, and a guard that misses a dead reference fails in the direction
//     this whole check exists to prevent. Failing loudly on the bare-caps form
//     costs one author one message, which names the convention.
//   * MCP namespaces only. Built-in tool names (Read, Bash, Skill) are ordinary
//     English words that appear throughout agent prose and would be pure noise.
// ---
describe('agent tools: allowlist covers every documented MCP namespace (#2526)', () => {
  const { parseFrontmatter, stripFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');
  const AGENTS_DIR = path.join(__dirname, '..', 'agents');

  // A tool name is `mcp__<server>__<tool>`; `<server>` may contain underscores
  // and hyphens (mcp__plugin_context7_context7__, mcp__chrome-devtools__).
  const REFERENCE_RE = /mcp__([A-Za-z0-9_-]+?)__/g;

  // Sentinel for "this allowlist grants every MCP server". Safe as a Set member
  // alongside real server ids: `*` is outside REFERENCE_RE's character class, so
  // no body reference can ever produce it and collide.
  const GRANT_ALL = '*';

  // The frontmatter parser preserves an INLINE comment inside a scalar value
  // (`tools: Read # mcp__playwright__*` parses as the literal string
  // `Read # mcp__playwright__*`), so a commented-out grant would otherwise read
  // as a real one. Full-line comments are already dropped by the parser.
  const stripInlineComment = (s) => String(s).replace(/\s+#.*$/, '');

  /** `tools:` as a token list. null = no tools: key at all (inherits everything). */
  function toolTokens(tools) {
    if (tools === undefined || tools === null) return null;
    const items = Array.isArray(tools) ? tools : [tools];
    return items
      .flatMap((t) => stripInlineComment(t).split(/[,\s]+/))
      .map((t) => t.trim())
      .filter(Boolean);
  }

  /** Server ids granted, from any accepted grant spelling. `GRANT_ALL` = every server. */
  function grantedServers(tokens) {
    const servers = new Set();
    for (const token of tokens) {
      if (!token.startsWith('mcp__')) continue;
      // A bare `mcp__*` is a wildcard over EVERY server, not a grant of the
      // empty-string server id. Without this branch it strips to '' and is
      // dropped by the `if (server)` guard below, so the one grant spelling
      // that plainly covers any body would flag every reference in it —
      // inverting the guard against a correct agent. A bare `mcp__` (no star)
      // is a typo rather than a wildcard and keeps failing closed.
      if (/^mcp__\*+$/.test(token)) { servers.add(GRANT_ALL); continue; }
      const rest = token.slice('mcp__'.length).replace(/\*+$/, '');
      // `mcp__srv__*` and `mcp__srv__tool` both grant `srv`; so does bare `mcp__srv`.
      const server = rest.includes('__') ? rest.slice(0, rest.indexOf('__')) : rest;
      if (server) servers.add(server.toLowerCase());
    }
    return servers;
  }

  /** Server ids a body references as tool namespaces. */
  function referencedServers(body) {
    const servers = new Set();
    for (const m of body.matchAll(REFERENCE_RE)) {
      if (m[1].length === 1) continue; // prose metavariable, e.g. mcp__X__*
      servers.add(m[1].toLowerCase());
    }
    return servers;
  }

  /** MCP servers an agent documents but does not grant. Empty = consistent. */
  function ungrantedServers(content) {
    const fm = parseFrontmatter(content) || {};
    const tokens = toolTokens(fm.tools);
    if (tokens === null) return [];
    const granted = grantedServers(tokens);
    if (granted.has(GRANT_ALL)) return [];
    // `description` ships with the agent and the dispatcher reads it, so an
    // mcp__ reference there is exactly as dead as one in the body. Only that
    // one field is scanned, never the whole frontmatter: `tools:` legitimately
    // contains the grants themselves and would self-reference into a
    // guaranteed pass.
    const documented = `${String(fm.description ?? '')}\n${stripFrontmatter(content)}`;
    return [...referencedServers(documented)]
      .filter((s) => !granted.has(s))
      .sort();
  }

  const agentFiles = fs.readdirSync(AGENTS_DIR).filter((f) => f.endsWith('.md')).sort();

  // Discovery guard: without this, a reorganisation that empties agentFiles
  // would silently delete every real assertion below while the synthetic
  // controls kept the suite green. Mirrors #1284's `referenced.size > 0`.
  test('agent discovery finds the agent definitions to check', () => {
    assert.ok(agentFiles.length >= 20,
      `expected agents/ to hold the agent definitions, found ${agentFiles.length}`);
    const anyGrant = agentFiles.some((f) => {
      const tokens = toolTokens((parseFrontmatter(
        fs.readFileSync(path.join(AGENTS_DIR, f), 'utf8')) || {}).tools);
      return tokens !== null && grantedServers(tokens).size > 0;
    });
    assert.ok(anyGrant, 'no agent grants any mcp__ namespace — the grant parser is not matching');
  });

  for (const file of agentFiles) {
    test(`${file}: documents no MCP namespace its tools: line withholds`, () => {
      const ungranted = ungrantedServers(fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8'));
      assert.deepStrictEqual(ungranted, [],
        `${file} documents mcp__${ungranted.join('__*, mcp__')}__* but its tools: allowlist ` +
        'grants none of them — those calls can never dispatch, so the instruction is dead ' +
        'and invites the agent to claim a path it cannot take (#2526). Either grant the ' +
        'namespace, drop the block, or — if this is a prose placeholder rather than a real ' +
        'server — spell it `mcp__<SERVER>__*`, the angle-bracket form this check ignores.');
    });
  }

  // Negative controls — these keep the property check from decaying into a
  // vacuous pass by proving the checker still FIRES, and still stays quiet, on
  // synthetic inputs independent of whatever agents/ happens to contain.
  describe('checker fires on known-bad input', () => {
    const agent = (fm, body) => ['---', ...fm, '---', '', ...body].join('\n');

    test('flags the #2526 shape: MCP block under an MCP-less allowlist', () => {
      assert.deepStrictEqual(
        ungrantedServers(agent(
          ['name: gsd-ui-auditor', 'tools: Read, Write, Bash, Grep, Glob, Skill'],
          ['Check whether `mcp__playwright__*` tools are available in this session.',
            'mcp__playwright__navigate(url="http://localhost:3000")'])),
        ['playwright']);
    });

    test('accepts the same body once the namespace is granted', () => {
      assert.deepStrictEqual(
        ungrantedServers(agent(
          ['name: a', 'tools: Read, mcp__playwright__*'],
          ['mcp__playwright__navigate(url="http://localhost:3000")'])),
        []);
    });

    test('an exact-tool grant covers its server (documented server-level scope)', () => {
      assert.deepStrictEqual(
        ungrantedServers(agent(['name: a', 'tools: mcp__playwright__navigate'],
          ['mcp__playwright__screenshot(name="desktop")'])),
        []);
    });

    test('a bare server-wide grant is recognised', () => {
      assert.deepStrictEqual(
        ungrantedServers(agent(['name: a', 'tools: Read, mcp__playwright'],
          ['mcp__playwright__navigate()'])),
        []);
    });

    // `mcp__*` strips to the empty string; without the wildcard branch it is
    // dropped as a grant of nothing, and the guard fires against an allowlist
    // that plainly covers the body — the one input shape that inverts it.
    test('a bare mcp__* wildcard grants every server', () => {
      assert.deepStrictEqual(
        ungrantedServers(agent(['name: a', 'tools: Read, mcp__*'],
          ['mcp__playwright__navigate()', 'mcp__chrome-devtools__take_screenshot()'])),
        []);
    });

    test('a bare mcp__ without a wildcard is a typo, not a grant', () => {
      assert.deepStrictEqual(
        ungrantedServers(agent(['name: a', 'tools: Read, mcp__'],
          ['mcp__playwright__navigate()'])),
        ['playwright']);
    });

    test('reads block-sequence tools:, not just the inline CSV form', () => {
      assert.deepStrictEqual(
        ungrantedServers(agent(
          ['name: a', 'tools:', '  - Read', '  - mcp__context7__*', 'color: pink'],
          ['Use mcp__context7__resolve-library-id, never mcp__tavily__search.'])),
        ['tavily']);
    });

    test('reads a YAML flow array', () => {
      assert.deepStrictEqual(
        ungrantedServers(agent(['name: a', 'tools: [Read, mcp__context7__*]'],
          ['mcp__context7__get-library-docs()'])),
        []);
    });

    test('reads a quoted scalar tools: value', () => {
      assert.deepStrictEqual(
        ungrantedServers(agent(['name: a', 'tools: "Read, mcp__playwright__*"'],
          ['mcp__playwright__navigate()'])),
        []);
    });

    test('server ids with hyphens are matched, not silently skipped', () => {
      assert.deepStrictEqual(
        ungrantedServers(agent(['name: a', 'tools: Read'],
          ['mcp__chrome-devtools__take_screenshot()'])),
        ['chrome-devtools']);
    });

    test('a commented-out grant does not count as granted (full-line form)', () => {
      assert.deepStrictEqual(
        ungrantedServers(agent(
          ['name: a', 'tools: Read', '# tools: mcp__playwright__*'],
          ['mcp__playwright__navigate()'])),
        ['playwright']);
    });

    test('a commented-out grant does not count as granted (inline form)', () => {
      assert.deepStrictEqual(
        ungrantedServers(agent(
          ['name: a', 'tools: Read # mcp__playwright__* withheld'],
          ['mcp__playwright__navigate()'])),
        ['playwright']);
    });

    // Boundary 2: a bare prose mention names a server without invoking it.
    test('bare prose naming a server is not treated as a reference', () => {
      assert.deepStrictEqual(
        ungrantedServers(agent(['name: a', 'tools: Read'],
          ['Screenshots come from the mcp__playwright server when the operator configures it.'])),
        []);
    });

    // Boundary 4: built-in tool names are ordinary English and must stay silent.
    test('built-in tool names in prose are never flagged', () => {
      assert.deepStrictEqual(
        ungrantedServers(agent(['name: a', 'tools: Read'],
          ['Use Write and Bash to Edit the file, then Grep and Glob for the results.'])),
        []);
    });

    test('ignores prose metavariables like mcp__X__*', () => {
      assert.deepStrictEqual(
        ungrantedServers(agent(['name: a', 'tools: Read, mcp__exa__*'],
          ['For any other provider id `X`: use `mcp__X__*` if available, else WebSearch.'])),
        []);
    });

    // The sanctioned spelling for a MULTI-character placeholder. Exempt by
    // construction — `<` is outside REFERENCE_RE's character class — so this
    // pins an existing property rather than adding a special case.
    test('the angle-bracket placeholder form is not a reference', () => {
      assert.deepStrictEqual(
        ungrantedServers(agent(['name: a', 'tools: Read'],
          ['For any provider: use `mcp__<SERVER>__*` when it is configured.'])),
        []);
    });

    // The deliberate other half: a bare all-caps id still fires. Exempting it
    // would be a false negative for any real server spelled in caps, and the
    // failure message names the angle-bracket form instead.
    test('a bare all-caps placeholder is still flagged, and fails closed', () => {
      assert.deepStrictEqual(
        ungrantedServers(agent(['name: a', 'tools: Read'],
          ['For any provider `SERVER`: use `mcp__SERVER__*` when configured.'])),
        ['server']);
    });

    // The metavariable exclusion is length===1 exactly: two characters is the
    // shortest server id that must still be recognized as a real reference.
    test('a two-character server id is a reference, not a metavariable', () => {
      assert.deepStrictEqual(
        ungrantedServers(agent(['name: a', 'tools: Read'],
          ['mcp__ab__foo()'])),
        ['ab']);
    });

    // Limit-1, completing the boundary triple (0 / 1 / 2). A zero-length id is
    // unrepresentable by REFERENCE_RE — `+?` requires at least one character —
    // so it is skipped by the pattern, never by the length===1 exclusion.
    test('a zero-length server id is not representable, and not a reference', () => {
      assert.deepStrictEqual(
        ungrantedServers(agent(['name: a', 'tools: Read'],
          ['mcp____foo()'])),
        []);
    });

    // The description ships and is read by the dispatcher, so it is part of
    // what the agent "documents" — scanning only the body left it exempt.
    test('an ungranted namespace in the description is flagged', () => {
      assert.deepStrictEqual(
        ungrantedServers(agent(
          ['name: a', 'description: Captures screens via mcp__playwright__navigate.',
            'tools: Read'],
          ['The body names no MCP tool at all.'])),
        ['playwright']);
    });

    // The `tools:` line is a grant list, not documentation of a call — scanning
    // the whole frontmatter would let every allowlist satisfy itself.
    test('the tools: line itself is never read as a body reference', () => {
      assert.deepStrictEqual(
        ungrantedServers(agent(['name: a', 'tools: Read, mcp__context7__*'],
          ['No MCP call appears in this body.'])),
        []);
    });

    test('an agent with no tools: key inherits everything', () => {
      assert.deepStrictEqual(
        ungrantedServers(agent(['name: a'], ['mcp__playwright__navigate()'])),
        []);
    });
  });
});

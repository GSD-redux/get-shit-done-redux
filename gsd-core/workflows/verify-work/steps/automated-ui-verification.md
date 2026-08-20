<step name="automated_ui_verification">
**Automated UI Verification (when Playwright-MCP is available)**

Before UAT, check whether Playwright/Puppeteer MCP tools are available. UI-phase
activation itself (`ui_phase_active`) is already resolved at init time — this
section is only reached when that fact is `true` (see the `state:ui-phase-active`
gate above), so re-deriving it here would be redundant.

```bash
UI_SPEC_FILE=$(ls "${PHASE_DIR}"/*-UI-SPEC.md 2>/dev/null | head -1)
```

**If Playwright-MCP tools are available in this session (`mcp__playwright__*` tools
respond to tool calls):**

For each UI checkpoint listed in the phase's UI-SPEC.md (or inferred from SUMMARY.md):

1. Use `mcp__playwright__navigate` (or equivalent) to open the component's URL.
2. Use `mcp__playwright__screenshot` to capture a screenshot.
3. Compare the screenshot visually against the spec's stated requirements
   (dimensions, color, layout, spacing).
4. Automatically mark checkpoints as **passed** or **needs review** based on the
   visual comparison — no manual question required for items that clearly match.
5. Flag items that require human judgment (subjective aesthetics, content accuracy)
   and present only those as manual UAT questions.

<!-- gsd:live-dom-families -->
**If `workflow.live_dom_uat` is enabled AND a Chrome-family browser MCP responds
(`mcp__chrome-devtools__*` or `mcp__claude-in-chrome__*`):**

Run the same checkpoint loop above using that server. Resolve the key first:

```bash
LIVE_DOM_UAT=$(gsd_run query config-get workflow.live_dom_uat 2>/dev/null || echo "false")
```

Treat any value other than `true` as disabled.

**Both conditions are required — tool presence alone is not sufficient.** A project may have
a Chrome-family browser MCP configured for entirely unrelated work; it must not be driven
here unless the operator opted in. This key is default-off.

If the browser profile is already locked (`The browser is already running for …`), report
those checkpoints as **could not look**, not as **needs review**, and name `--isolated` in
the summary — that flag lives on the operator's own MCP-server registration, not on anything
this workflow passes.
<!-- /gsd:live-dom-families -->

If automated verification is not available, fall back to the standard manual
checkpoint questions defined in this workflow unchanged. This step is entirely
conditional: if no browser MCP is configured — or `workflow.live_dom_uat` is off and only a
Chrome-family server is present — behavior is unchanged from today.

**Display summary line before proceeding:**
```
UI checkpoints: {N} auto-verified, {M} queued for manual review
```

</step>

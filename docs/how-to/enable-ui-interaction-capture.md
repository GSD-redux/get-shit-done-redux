# How to enable UI interaction capture

Let `/gsd-ui-review`'s auditor capture what a page looks like *after* an interaction — a hover
state, a focus ring, an open menu, a filled form's validation state — instead of only the first
paint, without configuring an MCP server or widening the agent's tool surface.

> **Default-off, and deliberately so.** The static capture path is unchanged in every
> configuration; this key adds captures on top of it. You opt in per project with one key.
> The gap it closes is [#4223](https://github.com/open-gsd/gsd-core/issues/4223): the auditor
> is chartered to audit interaction, and `npx playwright screenshot` has no interaction verb.

**What you need:**

- An installed Chrome or Chromium. The driver launches the system browser (Puppeteer
  `channel: 'chrome'`); it does not download one. Discovery tries `google-chrome`,
  `google-chrome-stable`, `chromium`, `chromium-browser` and `chrome` on `PATH`, then the
  standard macOS and Windows install paths. `CHROME_BIN=/path/to/chrome` overrides it.
- `npx` able to fetch `chrome-devtools-mcp` (the package that ships the `chrome-devtools` CLI).
  It is resolved at the documented floor `^1.8.0`; `CHROME_DEVTOOLS_MCP_VERSION` overrides it.
- A dev server the static capture already reaches — interaction capture runs against the same
  URL and skips itself when the static block reached nothing.

---

## Step 1 — Turn the key on

```bash
gsd-tools query config-set workflow.ui_interaction_capture true
```

Verify it took:

```bash
gsd-tools query config-get workflow.ui_interaction_capture
# → true
```

`/gsd-ui-review` reads the key and passes `interaction_capture: true` in the auditor's
`<config>` block — the auditor itself never reads config.

---

## Step 2 — Run a review and read the report

```bash
/gsd-ui-review 3
```

The audit's static captures land where they always did. With the key on and a Chrome
resolved, an `interaction/` directory beside them holds `baseline.png`, `focus-first.png`
(focus ring on the first focusable element), one capture per interaction the auditor drove
from your UI-SPEC's interactive components, the accessibility snapshot it used for element
ids, and the page's console output. `UI-REVIEW.md` carries the outcome on its own line:

```
**Interaction captures:** captured (4 state(s), 0 failed) in .planning/ui-reviews/03-.../interaction
```

The other values it can hold are honest, not decorative:

| `**Interaction captures:**` | Meaning |
|---|---|
| `off` | The key is `false`. Nothing else changed. |
| `skipped (no dev server reached)` | The static capture found no dev server; there was nothing to interact with. |
| `skipped (no Chrome binary resolved)` | The key is on but no browser resolved. Set `CHROME_BIN`. |
| `not captured (driver or capture failure)` | The daemon started but no state was captured — the audit output names the failing step. |

An interaction state that does not appear in that directory is not reported as observed; the
Experience Design pillar says when its findings are code-derived.

---

## What this does not do

- **It does not replace the static captures.** `npx playwright screenshot` stays the driver for
  the three viewport shots; it has `--wait-for-selector`, `--device`, `--color-scheme` and
  cross-engine `-b firefox|webkit`, none of which the CLI driver offers. Firefox and WebKit needs
  stay on Playwright.
- **It does not touch `gsd-dom-verifier` or `workflow.live_dom_uat`.** That capability drives a
  browser MCP server at execute time; this one drives a CLI from Bash at review time. They are
  independent keys.
- **It does not share the `chrome-devtools-mcp` browser profile.** The auditor starts the daemon
  with `--isolated`, so it never contends for the profile lock a registered MCP server holds, and
  stops it when the capture ends.
- **It does not wait on selectors.** `wait_for` is MCP-only; the auditor polls
  `document.readyState` through `evaluate_script` where a state needs settling.

---

## Turning it back off

```bash
gsd-tools query config-set workflow.ui_interaction_capture false
```

The next review runs the Playwright-only path and reports `**Interaction captures:** off`.

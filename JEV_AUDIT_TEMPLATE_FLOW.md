# Audit: creating a Nabla template through the Jev MCP server

Date: 2026-09-25
Task: on `http://localhost:3010/admin/system-encounter-profiles`, create a new
template ("Comprehensive Primary Care Visit (Claude demo)") with every available
setting exercised: visit type, format, merged Assessment & Plan, general custom
instructions, and per-section titles, styles, detail level, problem splitting,
numbering, differential diagnosis, custom instructions and hidden sections.

The template was created and saved. This document looks at how the MCP server
was used to get there, and what would make the same flow faster, in particular
by delegating more of it to Jev.

## TL;DR

About 96% of the wall-clock time was spent on the orchestrator's (Claude's)
turns between tool calls, not in the browser. The flow took about 5 minutes
(314 s) across about 60 MCP calls, of which only about 13 s was browser work.
Jev's single run made 3 decisions in 1.1 s for $0.00026.

Delegating the mechanical form filling to Jev is the right lever, but Jev cannot
currently do it on this page. Three problems block it:

1. `read_page` stops walking the page at depth 15, so Jev never sees the section
   controls, which sit at depth 20.
2. The running `server-jev.js` started before the `subgoals` batching parameter
   was committed, so the tool definition only accepts a single `goal`.
3. Controls covered by a side panel are still offered to Jev, and it picked
   one of them.

## Where the time went

| | Calls | Time |
|---|---|---|
| Whole flow (12:45:29 to 12:47:23) | about 60 | 314 s |
| Browser work in the extension | | about 13 s, of which 9.4 s was 4 humanized `type` calls at 2 to 2.7 s each |
| Jev (one `jev_navigate`, 3 decisions) | 1 | 1.1 s |

Source: `debug_timings` for tab 341355322, and the Jev trace
`~/.config/open-claude-in-chrome/jev-runs/2026-09-25T10-47-11-887Z-ff9b9u.json`.

Every browser-side call except `navigate` and humanized typing completed in
under 250 ms, most under 100 ms. The cost of the flow is the number of
orchestrator turns, so the goal is fewer, larger calls.

### Calls that did not make progress

About 20 of the 60 calls were overhead:

- **2 calls lost to screenshot scaling.** Screenshots are shown to the model at
  1024 px wide, while clicks use the real 1593 px viewport coordinates. The
  first click on "New template" opened the "New encounter" menu instead.
  Clicking by element reference worked correctly.
- **6 `javascript_tool` retries.** Several scripts returned only
  `Error: Uncaught` with no message. Wrapping the code in `try/catch` revealed
  the real errors (a `null` from a selector that did not match, and
  `Illegal invocation` when calling the native `HTMLInputElement` value setter).
- **2 `find` misses.** "New template button" returned the "My new template"
  entry, and the "Standard" dropdown option was not found at all.
- **About 10 verification screenshots.** The app resets some settings when
  others change (see below), so each batch of changes had to be checked visually.

## Why the form could not be delegated to Jev

### 1. Jev cannot see the section controls

`generateAccessibilityTree()` stops at depth 15 unless the caller passes a
`depth`:

```js
// extension/content.js
function generateAccessibilityTree(options = {}) {
  const filter = options.filter || "all";
  const maxDepth = options.depth || 15;
```

`observe()` in `host/jev/observe.js` calls
`read_page({ tabId, filter: "interactive", max_chars })` without a `depth`, so
it inherits the limit. Measured DOM depths on this page:

| Control | Depth from `<body>` |
|---|---|
| Template title input | 12 |
| Save button | 11 |
| Chief complaint custom title input | 20 |
| Chief complaint "Paragraph" button | 20 |

As a result, Jev's observation contained 29 to 37 elements: page chrome, the
title field, the visit type and format pickers, and Save. None of the 17
section cards were in it. The same limit is why the orchestrator had to fall
back to `javascript_tool` to find and configure the sections.

### 2. The `subgoals` batching parameter is not exposed

`host/jev/tools.js` defines a `subgoals` array that runs several legs in one
`jev_navigate` call, and `navigator.js` implements it (`normalizeSubgoals`). It
was committed at 12:14 (`65d4256`), but the running `host/server-jev.js`
process started at 11:39. The tool definition served to the client only
accepted `goal`, so each subgoal would have cost a separate orchestrator turn.

Restarting the server exposes batching with no code change.

### 3. Covered controls are still offered, and the value key did not match

The one `jev_navigate` call asked Jev to click "Add" next to "General custom
instructions" and type the provided text. The trace shows:

| Step | Rows offered | Operation | Target | P(CLICK) | P(TYPE_TEXT) |
|---|---|---|---|---|---|
| 1 | 29 | CLICK | "Add" (`ref_31`) | 0.74 | 0.01 |
| 2 | 37 | CLICK | "Add" (`ref_31`) | 0.87 | 0.04 |
| 3 | 37 | CLICK | "Add" (`ref_31`) | 0.88 | 0.04 |

The loop stopped with `needs_help`: "Two steps in a row left the page unchanged
after CLICK on button "Add"."

The loop did detect the side panel opening, since the row count went from 29
to 37. Jev then kept choosing the "Add" button that the panel now covers. Two
causes:

- Rows under an open dialog or side panel are still offered. The extension
  already has a click hit-test (`content.js` around line 552) that could be
  used to drop them.
- The panel's textbox is labelled "Click on an example above or type your own
  instructions here…", which does not resemble the value key
  `"general custom instruction"`, so typing never became likely.

## App behaviour that affects any automation

In this app, some toggles reset a section's style when they change:

- Turning on "Split by problem" reset the HPI and Assessment & Plan section
  style to "Auto" and the HPI detail level to "Normal".
- Turning on "Hide section by default" reset the Past obstetric history and
  Immunizations section style to "Auto".

Setting toggles before styles avoids this. More generally, a per-step success
check only looks at the current step, so it will not notice an earlier setting
being undone. A multi-leg Jev run on this form needs a final check against the
full intended configuration, done by Jev or by the orchestrator.

## Recommendations, most impactful first

1. **Let Jev see deep elements.** Pass a larger `depth` from `observe()`, or
   remove the default cap when `filter: "interactive"` is used. Without this,
   Jev cannot work on deeply nested React forms at all.
2. **Tell Jev which section each control belongs to.** Each card is a
   `<section aria-labelledby="CHIEF_COMPLAINT">`, but rows are a flat list in
   which "Paragraph" appears 17 times. Adding the nearest region or group name
   to each row (for example `Chief complaint › Paragraph`) would let a goal like
   "set Social history to Paragraph" resolve.
3. **Drop covered controls.** When an `aria-modal` dialog or side panel is open,
   exclude rows it covers, using the existing hit-test.
4. **Restart `server-jev.js`** so `subgoals` is exposed. Consider having the
   server warn when its tool definitions are older than the files on disk.
5. **Smaller fixes:**
   - Include the exception message in `javascript_tool` errors instead of
     `Error: Uncaught`.
   - Return click coordinates in the same scale as the screenshot the model is
     shown, or state the scale factor in the screenshot result.
   - Turn off humanized typing for trusted local hosts, or prefer `form_input`.
     That would save about 9 of the 13 browser seconds in this flow.

## What delegation would look like after fixes 1 to 4

The orchestrator would still decide the template content. Jev would then fill
it in through one or two `jev_navigate` calls with about 20 subgoals, passing
all the text as `values`, for example:

```json
{
  "tabId": 341355322,
  "start_url": "http://localhost:3010/admin/system-encounter-profiles",
  "values": {
    "template title": "Comprehensive Primary Care Visit (Claude demo)",
    "chief complaint title": "Reason for visit"
  },
  "subgoals": [
    { "goal": "Open a new template", "success_criteria": "An empty template form with a Title field is shown" },
    { "goal": "Type the template title", "success_criteria": "The Title field contains the template title" },
    { "goal": "Set visit type to Standard", "success_criteria": "Visit type shows Standard" },
    { "goal": "Set format to Multiple Sections", "success_criteria": "Format shows Multiple Sections and section settings are listed" },
    { "goal": "In the Chief complaint section, set the custom title and choose Paragraph", "success_criteria": "Chief complaint shows the custom title and Paragraph is selected" }
  ]
}
```

That is roughly 30 to 60 Jev decisions at about 300 ms each. The rough estimate
is 30 to 60 seconds for the whole flow instead of 5 minutes, plus a final
orchestrator check of the full configuration before saving.

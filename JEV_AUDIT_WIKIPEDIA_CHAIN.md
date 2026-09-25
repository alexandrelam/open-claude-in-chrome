# Audit: a multi-step Wikipedia chain run entirely by Jev

Date: 2026-09-25
Task: test whether Jev can carry a long browsing task on its own, with the
orchestrator (Claude) only writing the subgoals. On en.wikipedia.org, starting
from the Main Page:

1. Search for Octopus and open its revision history (warm-up run).
2. Search for Cephalopod, open its Talk page, switch the appearance to Dark,
   open "What links here", search for Nautilus, open Page information, open the
   revision history, and filter it by the `mobile edit` tag.

This follows `JEV_AUDIT_TEMPLATE_FLOW.md`, whose recommendations (deeper
`read_page`, section names on rows, covered-control filtering, `subgoals`,
`final_check`) were in the running server for this trial.

## TL;DR

Jev finished 8 of the 10 subgoals with no orchestrator involvement between
them, in three `jev_navigate` calls. A ninth, switching to Dark mode, actually
worked in the browser, but Jev could not confirm it. The warm-up and the first attempt at the long
chain were each one call. After the first attempt stopped, I restarted the
chain from where it had stopped, which took the third call.

In total there were 26 decisions in 22.5 s of wall-clock time, costing $0.0115.
Every browser decision took between 270 and 550 ms. The previous audit's
problem, where orchestrator turns took 96% of the time, did not appear here.

Two failures, and one inefficiency that wastes steps and could click the wrong
thing:

1. **Native radio and checkbox state was invisible to Jev.** The Dark mode
   click worked, but the observation never showed a radio as checked, so the
   success check stayed at p=0.06. The repeat guard stopped the loop after
   three identical clicks. Fixed in `7cd69d9`, but not yet verified live.
2. **The tag filter combobox defeated `TYPE_AND_SUBMIT`.** Typing `mobile edit`
   and pressing Enter landed on a revision diff page instead of a filtered
   history. Jev then gave up at 0.40 confidence, below the 0.6 threshold.
3. **A link click is judged "settled" before its navigation lands.** Clicking a
   link inside a dropdown closes the dropdown immediately, which changes the
   page signature, so the loop observes the old page. Jev then acts on the page
   that is about to be replaced. This happened twice and cost two wasted
   decisions.

The biggest remaining optimisation is structural. A third of all decisions (8
of 25) only confirm that a leg is finished (DONE). Merging that confirmation with the
next leg's first decision would remove one request per leg.

## The runs

| Run | Trace id | Subgoals | Decisions | Wall | Jev | Browser | Cost | Result |
|---|---|---|---|---|---|---|---|---|
| Octopus warm-up | `5w82jt` | 2 | 4 + final check | 4.1 s | 1.8 s | 1.7 s | $0.0025 | done |
| Long chain, attempt 1 | `jen9s2` | 3 of 8 | 7 | 7.9 s | 2.5 s | 2.3 s | $0.0030 | needs_help at Dark mode |
| Long chain, subgoals 4 to 8 | `1v9rva` | 4 of 5 | 14 | 10.5 s | 5.1 s | 4.2 s | $0.0060 | needs_help at tag filter |

Traces are in `~/.config/open-claude-in-chrome/jev-runs/2026-09-25T11-5*.json`.
The remaining wall time, about 3 s across the three runs, went to the
`start_url` navigation and to observing the page before the first step.

### How the decisions were spent

The table covers all 25 loop decisions across the three runs. The Octopus
warm-up's final check is a separate verification request and is not counted.

| Kind | Count | Share |
|---|---|---|
| Actions that moved the task forward | 10 | 40% |
| DONE confirmations, one per finished leg | 8 | 32% |
| Wasted: the same Dark click repeated | 3 | 12% |
| Wasted: a second "Tools" click after the link click | 2 | 8% |
| Wasted: tag filter, including the final low-confidence stop | 2 | 8% |

Every forward action had operation confidence of at least 0.86. Target
confidence was at least 0.94, except for the two links inside the Tools
dropdown, at 0.69 and 0.70 (see finding 3). Jev's choices were good, and the
cost of the flow is the loop's bookkeeping around them.

## Findings

### 1. Native checked state was missing from the observation

Run `jen9s2` steps 5 to 7:

| Step | Operation | Target | Satisfied |
|---|---|---|---|
| 5 | CLICK 0.99 | radio "Dark" 0.97 | 0.06 |
| 6 | CLICK 0.99 | radio "Dark" 0.96 | 0.07 |
| 7 | CLICK 0.99 | radio "Dark" 0.97 | 0.06 |

A `javascript_tool` check afterwards showed that the radio was checked and that
`<html>` had `skin-theme-clientpref-night`. There were two gaps:

- `generateAccessibilityTree()` in `extension/content.js` only emitted
  `checked=` from `aria-checked`, never from a native `<input>`'s `.checked`.
- `renderRow()` in `host/jev/shortlist.js` dropped `checked`, `expanded` and
  `selected`, even though `parseLine()` already parsed them.

Both are fixed in `7cd69d9`. A side benefit is that Wikipedia's "Tools" and
"Main menu" dropdowns are `<input type=checkbox>` toggles, so Jev can now see
whether they are open. That matters for finding 3.

This still needs verifying: reload the extension, restart the server, and
rerun the Dark subgoal. The expected result is CLICK, then DONE, in 2
decisions instead of a 3-decision failure.

### 2. `TYPE_AND_SUBMIT` on the tag filter combobox

Run `1v9rva` step 13 typed `mobile edit` into `combobox "Tag filter:"` and
submitted with 0.76 confidence. The next observation was on
`index.php?title=Nautilus&diff=1360712281&oldid=1360078281`, a revision diff
page. Where the Enter went was not investigated. The tag filter is an OOUI
multiselect with an autocomplete menu, and the history page also contains the
"Compare selected revisions" form, so either could have taken the key.

Once on the diff page, Jev's distribution split between CLICK (0.46),
TYPE_AND_SUBMIT (0.33) and BLOCKED (0.08). It aimed at a `Special:Tags` link
with 0.50 target confidence, and the 0.6 threshold correctly stopped it. The
gate did its job, since clicking there would not have helped.

Two lessons:

- Autocomplete comboboxes need TYPE_TEXT, then choosing the suggestion, then
  submitting through the form's own button. A blind Enter is not safe on
  them. The action layer could refuse TYPE_AND_SUBMIT on `role=combobox` and
  let the next decision pick from the listbox that opens.
- Nothing flagged the unexpected jump to a different page type. The loop only
  compares the URL before and after. A leg whose URL leaves the expected page,
  here from `action=history` to `diff=`, is worth a `needs_help` explaining
  what happened, rather than more decisions.

### 3. Link clicks settle before the navigation lands

Run `1v9rva`, subgoal "Open 'What links here' from the Tools menu":

| Step | URL | Rows | Action |
|---|---|---|---|
| 1 | Talk:Cephalopod | 160 | CLICK "Tools" (opens the dropdown) |
| 2 | Talk:Cephalopod | 170 | CLICK "What links here" link |
| 3 | Talk:Cephalopod | 160 | CLICK "Tools" again |
| 4 | Special:WhatLinksHere | 63 | DONE |

The same pattern appears in steps 7 to 10 of the same run, for Page
information.

The cause is in `runSubgoal()` in `host/jev/navigator.js`. For a CLICK, the
action is judged settled once `observationSignature` changes. Clicking a link
in the dropdown closes the dropdown, so the row count drops from 170 to 160 and
the signature changes at once, even though the navigation is still in flight.
Step 3 is then decided on a page that is about to disappear. Only
`SUBMITTING_OPERATIONS` wait for a URL change.

It cost two decisions here. It also carries a correctness risk: an action on
the outgoing page can land on the incoming page if the navigation commits
between the observation and the click.

Suggested fix: when the clicked row has an `href` that leaves the current
document (not a `#fragment` on the same page), wait for the URL to change,
using the existing 4 × 300 ms settle budget. If it does not change, fall back
to the signature check.

### 4. DONE costs a full request per leg

Each finished leg ends with a decision whose only purpose is `satisfied ≥
threshold`. Its observation is then thrown away (`ctx.obs = null`), and the
next leg observes the page and decides again. In `1v9rva`, 4 of the 14
requests were DONE confirmations, each costing one observation of about 300 ms
and one Jev round trip of about 330 ms.

The questions in a decision request are evaluated in parallel, so the next
leg's `operation` and `target` questions can be sent in the same request as the
current leg's `satisfied` question. If `satisfied` passes, the next leg's first
action is already decided on the same observation. If it fails, the extra
answers are ignored, costing tokens but no time. This saves about 0.6 s per
leg, and would have removed 7 of the 25 decisions in this trial.

The last leg of a run cannot be merged this way, and `final_check` still adds
one request when requested.

### 5. Smaller observations

- **The `jev_decide` output is mostly noise.** It returns the full target
  distribution: 240 entries, almost all 0, about 6 KB. Its ids (`e3`) also
  don't match its own `target_ref` (`ref_4`). Returning the top 5 as
  `{ref, label, p}` would fix both.
- **The page excerpt loses the page's subject.** `dropElementEcho()` strips
  text that duplicates an element name. On Wikipedia, "Octopus" and "Nautilus"
  are also link names, so the excerpt reads ": Revision history" and
  "Talk: Page contents…". The loop is unaffected, but anyone reading the
  excerpt loses the one word that says where they are. `final_title` has it,
  so the harm is small.
- **Article pages truncate.** The Octopus and Cephalopod articles returned
  `truncated: true`, with over 1,100 rows cut before shortlisting. Every
  control needed here sat in the page chrome near the top, so it did not
  matter. On a page where the target is deep in a long article it would.
- **Values are matched weakly.** On `Special:WhatLinksHere`, which has its own
  search form, `value_key: search` dropped to 0.41 confidence (0.71 against
  NONE). It still typed into the right box, but a less literal key than
  `search` would probably have fallen below the threshold.
- **Tokens and cost are not a concern.** Requests averaged about 10k input
  tokens and $0.00044 each. The 240-row cap is reached on almost every
  Wikipedia page, but at about 330 ms per decision it isn't the bottleneck.

## Recommendations, most impactful first

1. **Verify the checked-state fix live** (finding 1). This needs only a reload
   of the extension and a server restart.
2. **Wait for navigation after clicking an off-page link** (finding 3). This is
   a small change in `runSubgoal()`, and it prevents actions on the outgoing
   page.
3. **Merge each leg's DONE with the next leg's first decision** (finding 4).
   It saves about 28% of the requests on multi-leg runs.
4. **Treat autocomplete comboboxes specially** (finding 2). Do not
   TYPE_AND_SUBMIT into `role=combobox`, and return `needs_help` when a leg
   lands on an unrelated page type.
5. **Trim the `jev_decide` output to the top 5 and use one id space** (finding
   5).

## What this trial says about delegation

With the previous audit's fixes in place, Jev handled this style of browsing
(search, tabs, dropdown menus, radios, page tools) with high confidence. The
orchestrator's only involvement was writing 10 subgoals and restarting the
chain once after a failure.

Recommendations 1 to 3 cover every failure and wasted step seen here except
the tag filter. With them in place, the long chain would likely run in one call
of about 12 decisions and under 10 s, with only the combobox leg still needing
work.

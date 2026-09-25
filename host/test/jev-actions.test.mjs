#!/usr/bin/env node
//
// The action space, the safety gate, and config precedence.
//
// The action table is the security boundary of this feature: Jev's answer is
// only ever a key into a set built from an observation we just took, and the
// tools that could turn a model's output into a selector, a URL or code are not
// in the table at all. These tests assert that property directly, because "we
// remembered not to add navigate" is not something a reader can verify by
// looking at a denylist.
//
// Run: node host/test/jev-actions.test.mjs

import {
  OPERATIONS, isCompatible, availableOperations, looksSensitive, planToolCalls, rowLabel
} from "../jev/actions.js";
import { resolveConfig, configError, MAX_STEPS_CEILING, MAX_CHOICES } from "../jev/config.js";
import { splitSections, shortlistRows, estimateTokens, STATE_TOKEN_BUDGET } from "../jev/shortlist.js";
import { prefilter, isNoise, isControl, termsFrom } from "../jev/relevance.js";

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name} — ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

const row = (o) => ({ ref: "ref_1", role: "", name: "", href: "", value: "", type: "", options: null, indent: 0, ...o });

await check("the dangerous tools are absent from the action space entirely", async () => {
  const emitted = new Set();
  for (const op of Object.keys(OPERATIONS)) {
    for (const call of planToolCalls(op, row({ role: "button", type: "text" }), "v", 1)) emitted.add(call[0]);
  }
  for (const banned of ["navigate", "javascript_tool", "file_upload", "upload_image"]) {
    assert(!emitted.has(banned), `${banned} is reachable from the action table`);
  }
  assert(emitted.has("computer") && emitted.has("form_input"), "the permitted tools should still be reachable");
});

await check("CLICK accepts clickable roles and hrefs, rejects text fields", async () => {
  assert(isCompatible("CLICK", row({ role: "button" })), "button");
  assert(isCompatible("CLICK", row({ role: "link" })), "link");
  // An anchor often renders with no role at all; the href is the evidence.
  assert(isCompatible("CLICK", row({ role: "", href: "https://x.test" })), "roleless anchor");
  // Text fields are covered by their own case below; a link is the real
  // negative here.
  assert(!isCompatible("TYPE_TEXT", row({ role: "link", href: "https://x.test" })), "a link is not typeable");
});

await check("TYPE_TEXT accepts editable fields only", async () => {
  assert(isCompatible("TYPE_TEXT", row({ role: "textbox" })), "textbox");
  assert(isCompatible("TYPE_TEXT", row({ role: "searchbox" })), "searchbox");
  assert(!isCompatible("TYPE_TEXT", row({ role: "link" })), "link is not editable");
});

await check("PRESS_ENTER exists, so a typed query can actually be submitted", async () => {
  // Regression for the first real multi-step run: the loop typed a search query
  // and then had no legal move to submit it. Many pages only accept Enter.
  assert(isCompatible("PRESS_ENTER", row({ role: "searchbox" })), "searchbox");
  assert(isCompatible("PRESS_ENTER", row({ type: "text" })), "plain input");
  assert(!isCompatible("PRESS_ENTER", row({ role: "link", href: "https://x.test" })), "not a link");
  assert(availableOperations([row({ role: "searchbox" })]).includes("PRESS_ENTER"), "offered when a field exists");
  assert(!availableOperations([row({ role: "link", href: "https://x.test" })]).includes("PRESS_ENTER"), "not offered otherwise");
});

await check("PRESS_ENTER focuses the field before the keystroke", async () => {
  // The key action dispatches to whatever has focus and ignores ref, and
  // form_input never focuses anything, so without the click the Enter lands
  // nowhere.
  const calls = planToolCalls("PRESS_ENTER", row({ ref: "ref_4", role: "searchbox" }), undefined, 9);
  eq(calls.length, 2, "two calls");
  eq(calls[0][1].action, "left_click", "focus first");
  eq(calls[0][1].ref, "ref_4", "on the field");
  eq(calls[1][1].action, "key", "then the key");
  eq(calls[1][1].text, "Return", "Enter");
});

await check("a text field can be clicked, not only typed into", async () => {
  // Treating CLICK and TYPE_TEXT as mutually exclusive was too strict: focusing
  // a field or opening its suggestions list is ordinary behaviour, and refusing
  // it stranded a real run at needs_help.
  assert(isCompatible("CLICK", row({ role: "searchbox" })), "searchbox is clickable");
  assert(isCompatible("CLICK", row({ role: "textbox" })), "textbox is clickable");
  assert(isCompatible("CLICK", row({ type: "text" })), "plain input is clickable");
});

await check("targetless operations need no row", async () => {
  for (const op of ["SCROLL_UP", "SCROLL_DOWN", "WAIT", "DONE", "BLOCKED"]) {
    assert(isCompatible(op, null), `${op} should not require a target`);
  }
  assert(!isCompatible("CLICK", null), "CLICK must require a target");
});

await check("availableOperations only offers what the page supports", async () => {
  const ops = availableOperations([row({ role: "link", href: "https://x.test" })]);
  assert(ops.includes("CLICK"), "CLICK available");
  assert(!ops.includes("TYPE_TEXT"), "TYPE_TEXT must not be offered with no editable field");
  assert(ops.includes("DONE") && ops.includes("BLOCKED"), "the exits are always available");
});

await check("the keyword gate catches sensitive labels independently of the model", async () => {
  assert(looksSensitive(row({ name: "Delete account" })), "delete");
  assert(looksSensitive(row({ name: "Confirm payment" })), "payment");
  assert(looksSensitive(row({ name: "Publish post" })), "publish");
  assert(!looksSensitive(row({ name: "Search" })), "search is not sensitive");
});

await check("TYPE_TEXT uses form_input on real controls and click-then-type elsewhere", async () => {
  // form_input sets the value and fires the events a framework listens for in
  // one round trip, but only works on real form controls — `type` on the row is
  // what tells us it is one.
  const control = planToolCalls("TYPE_TEXT", row({ ref: "ref_4", type: "search" }), "shoes", 7);
  eq(control.length, 1, "one call for a real input");
  eq(control[0][0], "form_input", "tool");

  const rich = planToolCalls("TYPE_TEXT", row({ ref: "ref_5", role: "textbox" }), "hello", 7);
  eq(rich.length, 2, "select-all then type for a contenteditable");
  eq(rich[0][1].action, "triple_click", "first clears the field");
  eq(rich[1][1].text, "hello", "then types");
});

await check("every planned call carries the tabId it was given", async () => {
  for (const op of ["CLICK", "SELECT", "SCROLL_DOWN", "WAIT"]) {
    for (const [, args] of planToolCalls(op, row({ role: "button", options: [] }), "v", 42)) {
      eq(args.tabId, 42, `${op} tabId`);
    }
  }
});

await check("config precedence: env over file over defaults", async () => {
  const file = { jev: { model: "typesafe/jev-1.13", min_confidence: 0.9, budget_usd: 2 } };
  const cfg = resolveConfig({ JEV_MODEL: "from-env", OPENROUTER_API_KEY: "k" }, file);
  eq(cfg.model, "from-env", "env wins");
  eq(cfg.minConfidence, 0.9, "file beats the default");
  eq(cfg.maxSteps, 20, "the default applies where neither sets it");
});

await check("max_steps cannot be raised past the hard ceiling", async () => {
  const cfg = resolveConfig({ JEV_MAX_STEPS: "500", OPENROUTER_API_KEY: "k" }, {});
  eq(cfg.maxSteps, MAX_STEPS_CEILING, "clamped");
});

await check("an empty allowlist is not the same as no allowlist", async () => {
  // null means "no allowlist, every domain permitted"; [] is an allowlist that
  // permits nothing, which is a legitimate way to switch the loop off.
  eq(resolveConfig({ OPENROUTER_API_KEY: "k" }, {}).allowedDomains, null, "absent means null");
  const empty = resolveConfig({ OPENROUTER_API_KEY: "k" }, { jev: { allowed_domains: [] } });
  assert(Array.isArray(empty.allowedDomains) && empty.allowedDomains.length === 0, "empty array is preserved");
});

await check("a missing key names the key and says the other tools still work", async () => {
  const err = configError(resolveConfig({}, {}));
  assert(err && err.includes("OPENROUTER_API_KEY"), "names the key");
  assert(err.includes("without it"), "says the browser tools are unaffected");
  assert(configError(resolveConfig({ OPENROUTER_API_KEY: "k" }, {})) === null, "no error when set");
  assert(configError(resolveConfig({ JEV_PROVIDER: "typesafe" }, {})).includes("TYPESAFE_API_KEY"), "names the right key per provider");
});

await check("a page that fits is passed through untouched and costs no Jev call", async () => {
  const rows = Array.from({ length: 30 }, (_, i) => row({ ref: `ref_${i}`, role: "button", name: `B${i}` }));
  let called = 0;
  const out = await shortlistRows(rows, { goal: "g", successCriteria: "s", maxRows: 120, decide: async () => { called++; return { answers: {} }; } });
  eq(out.rows.length, 30, "all rows kept");
  eq(out.cut, 0, "nothing cut");
  eq(called, 0, "no scoring pass for a small page");
});

await check("a large page is narrowed without a scoring round trip", async () => {
  // This used to require a Jev *scoring* request on every step. The
  // deterministic prefilter now gets an ordinary dense page under the cap on
  // its own, which is the whole point: that pass was a second round trip on
  // exactly the pages that were already slowest.
  const rows = Array.from({ length: 400 }, (_, i) =>
    row({ ref: `ref_${i}`, role: "link", name: `Section heading ${i}`, href: `https://x.test/${i}` })
  );
  let scored = 0;
  const out = await shortlistRows(rows, {
    goal: "g", successCriteria: "s", maxRows: 60,
    decide: async () => { scored++; return { answers: {} }; }
  });
  eq(scored, 0, "no scoring request");
  eq(out.rows.length, 60, "narrowed to the cap");
  assert(out.cut > 0, "reports what was lost");
  const refs = out.rows.map((r) => Number(r.ref.split("_")[1]));
  assert(refs.every((v, i) => i === 0 || v > refs[i - 1]), "survivors stay in document order");
});

await check("citation markers and nameless rows are dropped as noise", async () => {
  // Measured on a Wikipedia article: 115 of 602 rows were "[1]"-style citation
  // markers and 11 had no accessible name at all. Neither can ever be the thing
  // the user asked for.
  const rows = [
    row({ ref: "ref_1", role: "link", name: "[1]", href: "https://x.test/#cite1" }),
    row({ ref: "ref_2", role: "link", name: "[42]", href: "https://x.test/#cite42" }),
    row({ ref: "ref_3", role: "link", name: "", href: "" }),
    row({ ref: "ref_4", role: "link", name: "Past revisions of this page", href: "https://x.test/history" })
  ];
  const out = prefilter(rows, { goal: "g", successCriteria: "s", values: {}, limit: 50 });
  eq(out.noise, 3, "three noise rows");
  eq(out.rows.length, 1, "the real link survives");
  eq(out.rows[0].ref, "ref_4", "and it is the right one");
});

await check("controls survive the cap no matter where they sit on the page", async () => {
  // A form control is what actions are made of; losing one to a document-order
  // cut would make the page unusable.
  const rows = [
    ...Array.from({ length: 300 }, (_, i) => row({ ref: `ref_${i}`, role: "link", name: `Body link ${i}`, href: `https://x.test/${i}` })),
    row({ ref: "ref_deep", role: "searchbox", name: "Search", type: "search" })
  ];
  const out = prefilter(rows, { goal: "find something", successCriteria: "s", values: {}, limit: 50 });
  assert(out.rows.some((r) => r.ref === "ref_deep"), "the searchbox survived");
});

await check("a row matching the goal survives even when buried deep", async () => {
  // Document order is only the tie-break. Lexical matching is what rescues a
  // target that sits past the cut.
  const rows = [
    ...Array.from({ length: 300 }, (_, i) => row({ ref: `ref_${i}`, role: "link", name: `Unrelated ${i}`, href: `https://x.test/${i}` })),
    row({ ref: "ref_target", role: "link", name: "Blink browser engine", href: "https://x.test/blink" })
  ];
  const out = prefilter(rows, { goal: "open the Blink article", successCriteria: "the Blink page is shown", values: {}, limit: 50 });
  assert(out.rows.some((r) => r.ref === "ref_target"), "the goal-matching row survived the cut");
});

await check("lexical matching only adds rows, it never removes them", async () => {
  // The critical safety property. Measured case: the goal "open the page's edit
  // history" has ZERO word overlap with the link that does it, "Past revisions
  // of this page". A filter that required a lexical hit would have cut the one
  // right answer.
  const rows = [
    row({ ref: "ref_1", role: "link", name: "Past revisions of this page", href: "https://x.test/history" }),
    row({ ref: "ref_2", role: "link", name: "Something else", href: "https://x.test/other" })
  ];
  const out = prefilter(rows, { goal: "open the page's edit history", successCriteria: "revisions are listed", values: {}, limit: 50 });
  eq(out.rows.length, 2, "nothing removed when under the cap");
  assert(out.rows.some((r) => r.ref === "ref_1"), "the zero-overlap target is still there");
});

await check("shortlisting degrades deterministically with no scorer", async () => {
  const rows = Array.from({ length: 200 }, (_, i) => row({ ref: `ref_${i}`, role: "button", name: `B${i}` }));
  const out = await shortlistRows(rows, { goal: "g", successCriteria: "s", maxRows: 50, decide: null });
  eq(out.rows.length, 50, "truncated to the cap");
  eq(out.scored, false, "flagged as unscored");
  eq(out.cut, 150, "cut count");
});

await check("splitSections keeps rows contiguous and loses none", async () => {
  const rows = Array.from({ length: 95 }, (_, i) => row({ ref: `ref_${i}`, indent: i % 25 === 0 ? 0 : 2 }));
  const secs = splitSections(rows);
  assert(secs.length > 1, "should split");
  eq(secs.flat().length, 95, "no row dropped");
  eq(secs.flat()[0].ref, "ref_0", "order preserved");
});

await check("max_rows is clamped to the provider's 255-choice ceiling", async () => {
  // Not a preference: the Decisions API rejects a Choice with more than 255
  // options outright (HTTP 400, "Too many choices"). A user raising the knob
  // must get a smaller action space, never a failed request.
  eq(resolveConfig({ JEV_MAX_ROWS: "500", OPENROUTER_API_KEY: "k" }, {}).maxRows, MAX_CHOICES, "env clamped");
  eq(resolveConfig({ OPENROUTER_API_KEY: "k" }, { jev: { max_rows: 9999 } }).maxRows, MAX_CHOICES, "file clamped");
  assert(resolveConfig({ OPENROUTER_API_KEY: "k" }, {}).maxRows <= MAX_CHOICES, "the default is under the ceiling");
});

await check("a typical article is shortlisted, but by the ceiling and not by tokens", async () => {
  // Measured on a Wikipedia article (2026-09-25): ~400 usable rows serializing
  // to ~1,100 tokens, i.e. 3.6% of the 32k window. The token budget has ample
  // room; it is the provider's choice ceiling that forces the scoring pass.
  const cfg = resolveConfig({ OPENROUTER_API_KEY: "k" }, {});
  const rows = Array.from({ length: 400 }, (_, i) =>
    row({ ref: `ref_${i}`, role: "link", name: `Section heading ${i}`, href: `https://en.wikipedia.org/wiki/Topic_${i}` })
  );
  const serialized = rows.map((r, i) => `e${i + 1} | ${r.role} | ${r.name}`).join("\n");
  assert(
    estimateTokens(serialized) < STATE_TOKEN_BUDGET / 2,
    `tokens should not be the binding constraint here, got ${estimateTokens(serialized)}`
  );
  const out = await shortlistRows(rows, {
    goal: "g", successCriteria: "s", maxRows: cfg.maxRows,
    decide: async (_s, q) => {
      const answers = {};
      Object.keys(q).forEach((k, i) => { answers[k] = { type: "score", score: i, confidence: 0.9 }; });
      return { answers };
    }
  });
  assert(out.rows.length <= MAX_CHOICES, `offered ${out.rows.length}, ceiling is ${MAX_CHOICES}`);
});

await check("the token estimate is what actually gates, not the row count", async () => {
  const fat = Array.from({ length: 40 }, (_, i) => row({ ref: `ref_${i}`, role: "link", name: "x".repeat(100), href: "https://x.test/" + "y".repeat(300) }));
  assert(estimateTokens(fat.map((r) => r.name + r.href).join("")) > 3000, "these rows are genuinely large");
  assert(STATE_TOKEN_BUDGET < 32_000, "the budget must leave room for questions and answers inside the 32k window");
});

await check("rowLabel degrades to href then ref rather than returning nothing", async () => {
  eq(rowLabel(row({ role: "button", name: "Go" })), 'button "Go"', "role and name");
  eq(rowLabel(row({ href: "https://x.test" })), "https://x.test", "href fallback");
  eq(rowLabel(row({ ref: "ref_9" })), "ref_9", "ref fallback");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);

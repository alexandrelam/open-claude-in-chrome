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
import { resolveConfig, configError, MAX_STEPS_CEILING } from "../jev/config.js";
import { splitSections, shortlistRows, estimateTokens, STATE_TOKEN_BUDGET } from "../jev/shortlist.js";

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
  assert(!isCompatible("CLICK", row({ role: "textbox" })), "textbox is not clickable");
});

await check("TYPE_TEXT accepts editable fields only", async () => {
  assert(isCompatible("TYPE_TEXT", row({ role: "textbox" })), "textbox");
  assert(isCompatible("TYPE_TEXT", row({ role: "searchbox" })), "searchbox");
  assert(!isCompatible("TYPE_TEXT", row({ role: "link" })), "link is not editable");
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

await check("a large page is scored, cut to the cap, and reports what was lost", async () => {
  const rows = Array.from({ length: 200 }, (_, i) => row({ ref: `ref_${i}`, role: "button", name: `Button number ${i}`, indent: i % 20 === 0 ? 0 : 2 }));
  // Score the later sections highest, so a correct implementation must reorder
  // by relevance and then restore document order.
  const decide = async (_state, questions) => {
    const answers = {};
    Object.keys(questions).forEach((k, idx) => { answers[k] = { type: "score", score: idx, confidence: 0.9 }; });
    return { answers };
  };
  const out = await shortlistRows(rows, { goal: "g", successCriteria: "s", maxRows: 60, decide });
  assert(out.scored, "should have scored");
  assert(out.rows.length <= 60, `kept ${out.rows.length}, cap was 60`);
  assert(out.cut > 0, "should report the cut");
  const refs = out.rows.map((r) => Number(r.ref.split("_")[1]));
  assert(refs.every((v, i) => i === 0 || v > refs[i - 1]), "survivors must be back in document order");
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

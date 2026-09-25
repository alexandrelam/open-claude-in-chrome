#!/usr/bin/env node
//
// The navigator loop and its gate.
//
// Two halves. `validate()` is tested directly, because it is the deterministic
// check that stands between a model's answer and a click in someone's real,
// logged-in browser, and every one of its refusals should be legible on its own.
// Then the loop is driven end to end against a fake browser and a fake Jev, to
// pin the terminal states and the three ways it gives up: no progress, the same
// action over and over, and the caps.
//
// Run: node host/test/jev-navigator.test.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validate, buildRequest, navigate, decideOnce } from "../jev/navigator.js";
import { resolveConfig } from "../jev/config.js";

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

const CFG = {
  ...resolveConfig({ OPENROUTER_API_KEY: "k" }, {}),
  tracesDir: fs.mkdtempSync(path.join(os.tmpdir(), "jev-trace-"))
};

const row = (o) => ({ ref: "ref_1", role: "", name: "", href: "", value: "", type: "", options: null, indent: 0, ...o });
const choice = (c, conf, probs) => ({ type: "choice", choice: c, confidence: conf, probabilities: probs ?? { [c]: conf } });
const noul = (p) => ({ type: "noul", noul: p, confidence: Math.abs(p - 0.5) * 2 });

// --- validate(): the gate, on its own ---------------------------------------

await check("validate passes a confident, compatible, harmless action", async () => {
  const map = new Map([["e1", row({ ref: "ref_3", role: "button", name: "Search" })]]);
  const v = validate({ operation: choice("CLICK", 0.9), target: choice("e1", 0.85), sensitive: noul(0.02) }, map, CFG, { allowSensitive: false, values: {} });
  assert(v.ok, `should pass: ${v.reason}`);
  eq(v.row.ref, "ref_3", "resolved to the real ref");
});

await check("validate rejects a ref Jev was never offered", async () => {
  // The whole containment argument rests on this: eN is a key into a set we
  // just built, so anything else is not a stale ref, it is not a ref at all.
  const map = new Map([["e1", row({ role: "button", name: "Search" })]]);
  const v = validate({ operation: choice("CLICK", 0.9), target: choice("e99", 0.9), sensitive: noul(0) }, map, CFG, { allowSensitive: false, values: {} });
  eq(v.status, "needs_help", "status");
  assert(v.reason.includes("e99"), "names what it rejected");
});

await check("validate rejects an operation the element cannot take", async () => {
  const map = new Map([["e1", row({ role: "link", name: "Docs", href: "https://x.test" })]]);
  const v = validate({ operation: choice("TYPE_TEXT", 0.95), target: choice("e1", 0.95), sensitive: noul(0), value_key: choice("q", 1) }, map, CFG, { allowSensitive: false, values: { q: "hi" } });
  eq(v.status, "needs_help", "status");
  assert(v.reason.includes("TYPE_TEXT"), "names the operation");
});

await check("confidence is the weaker of operation and target, not the operation alone", async () => {
  // A confident CLICK aimed at a coin-flip element is not a confident action.
  const map = new Map([["e1", row({ role: "button", name: "Go" })]]);
  const v = validate({ operation: choice("CLICK", 0.99), target: choice("e1", 0.3), sensitive: noul(0) }, map, CFG, { allowSensitive: false, values: {} });
  eq(v.status, "needs_help", "should fall below the 0.6 gate");
  assert(v.reason.includes("0.30"), "reports the combined figure");
});

await check("a sensitive label is refused even when the model calls it safe", async () => {
  const map = new Map([["e1", row({ role: "button", name: "Delete account" })]]);
  const v = validate({ operation: choice("CLICK", 0.95), target: choice("e1", 0.95), sensitive: noul(0.01) }, map, CFG, { allowSensitive: false, values: {} });
  eq(v.status, "needs_help", "status");
  assert(v.reason.includes("sensitive keyword"), "says which gate tripped");
});

await check("a sensitive model answer is refused even when the label looks innocent", async () => {
  const map = new Map([["e1", row({ role: "button", name: "Proceed" })]]);
  const v = validate({ operation: choice("CLICK", 0.95), target: choice("e1", 0.95), sensitive: noul(0.9) }, map, CFG, { allowSensitive: false, values: {} });
  eq(v.status, "needs_help", "status");
});

await check("allow_sensitive lets a deliberate destructive action through", async () => {
  const map = new Map([["e1", row({ role: "button", name: "Delete account" })]]);
  const v = validate({ operation: choice("CLICK", 0.95), target: choice("e1", 0.95), sensitive: noul(0.9) }, map, CFG, { allowSensitive: true, values: {} });
  assert(v.ok, `should pass when explicitly allowed: ${v.reason}`);
  eq(v.sensitive, true, "still flagged for the trace");
});

await check("needs_value names the field, so Claude knows what to supply", async () => {
  const map = new Map([["e1", row({ role: "textbox", name: "Coupon code", type: "text" })]]);
  const v = validate({ operation: choice("TYPE_TEXT", 0.95), target: choice("e1", 0.95), sensitive: noul(0), value_key: choice("NONE", 0.9) }, map, CFG, { allowSensitive: false, values: { other: "x" } });
  eq(v.status, "needs_value", "status");
  assert(v.reason.includes("Coupon code"), "names the field");
  assert(v.reason.includes("textbox"), "names the role");
});

await check("BLOCKED from Jev is a clean stop, not an error", async () => {
  const v = validate({ operation: choice("BLOCKED", 0.8), sensitive: noul(0) }, new Map(), CFG, { allowSensitive: false, values: {} });
  eq(v.status, "blocked", "status");
});

await check("buildRequest never puts a ref in front of Jev", async () => {
  const obs = { url: "https://x.test", title: "T", excerpt: "e", rows: [] };
  const rows = [row({ ref: "ref_77", role: "button", name: "Go" })];
  const { state, questions, idMap } = buildRequest(obs, rows, { goal: "g", successCriteria: "s", values: {} });
  const sent = JSON.stringify({ state, questions });
  assert(!sent.includes("ref_77"), "a real ref leaked into the request");
  assert(sent.includes("e1"), "rows are addressed as eN");
  eq(idMap.get("e1").ref, "ref_77", "the mapping back is held locally");
});

await check("buildRequest omits the target question when there is nothing to target", async () => {
  // A Choice with no options is a malformed request; on an empty page the only
  // sensible answers are the targetless ones anyway.
  const { questions } = buildRequest({ url: "", title: "", excerpt: "", rows: [] }, [], { goal: "g", successCriteria: "s", values: {} });
  assert(!questions.target, "no target question");
  assert(questions.operation && questions.sensitive, "the rest still asked");
});

// --- the loop, end to end ----------------------------------------------------

function renderPage(rows) {
  return rows
    .map((r) => `${r.role}${r.name ? ` "${r.name}"` : ""} [${r.ref}]${r.href ? ` href="${r.href}"` : ""}${r.type ? ` type="${r.type}"` : ""}`)
    .join("\n");
}

/** A fake browser: enough of the three observation tools to drive the loop. */
function fakeBrowser({ url = "https://app.test/a", title = "A", rows = [], onClick } = {}) {
  const state = { url, title, rows };
  const calls = [];
  const text = (t) => ({ content: [{ type: "text", text: t }] });
  const callTool = async (name, args) => {
    calls.push({ name, args });
    switch (name) {
      case "read_page":
        return text(renderPage(state.rows));
      case "get_page_text":
        return text("page body text");
      case "tabs_context_mcp":
        return text(JSON.stringify({ availableTabs: [{ tabId: 1, title: state.title, url: state.url }], tabGroupId: 1 }) + "\n\nprose\n");
      case "computer":
      case "form_input":
        if (onClick) onClick(state, args);
        return text("ok");
      case "navigate":
        state.url = args.url;
        return text("ok");
      default:
        return text("ok");
    }
  };
  return { callTool, calls, state };
}

/** A fake Jev: a scripted list of answer sets, with the last one repeating. */
function fakeClient(script) {
  let i = 0;
  const seen = [];
  return {
    decide: async (state, questions) => {
      seen.push({ state, questions });
      const answers = script[Math.min(i++, script.length - 1)];
      return { answers: typeof answers === "function" ? answers(state, questions) : answers, ms: 5, usage: { cost: 0.00005 } };
    },
    seen,
    totals: { requests: 0, cost_usd: 0, input_tokens: 0, budget_usd: 1, resolved_model: "typesafe/jev-1.13" }
  };
}

await check("a click then a confirmed DONE returns done with the steps taken", async () => {
  const browser = fakeBrowser({
    rows: [row({ ref: "ref_1", role: "link", name: "Invoices", href: "https://app.test/inv" })],
    onClick: (s) => { s.url = "https://app.test/inv/9"; s.title = "Invoice 9"; s.rows = [row({ ref: "ref_1", role: "button", name: "Download" })]; }
  });
  const client = fakeClient([
    { operation: choice("CLICK", 0.95), target: choice("e1", 0.95), sensitive: noul(0.01) },
    { operation: choice("DONE", 0.95), sensitive: noul(0.01) },
    { satisfied: noul(0.95) }
  ]);
  const out = await navigate(browser.callTool, client, CFG, { tabId: 1, goal: "open the latest invoice", success_criteria: "an invoice detail page is shown" });
  eq(out.status, "done", `reason: ${out.reason}`);
  eq(out.steps[0].operation, "CLICK", "first step");
  eq(out.steps[0].target_ref, "ref_1", "target recorded");
  eq(out.final_url, "https://app.test/inv/9", "final url");
  assert(out.page_excerpt?.interactive?.length > 0, "an excerpt of the final page is returned so Claude need not re-read it");
  assert(out.run_id, "a run id is returned");
});

await check("a trace lands on disk for the run", async () => {
  const before = fs.readdirSync(CFG.tracesDir).length;
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Go" })] });
  const client = fakeClient([{ operation: choice("BLOCKED", 0.9), sensitive: noul(0) }]);
  const out = await navigate(browser.callTool, client, CFG, { tabId: 1, goal: "g", success_criteria: "s" });
  const files = fs.readdirSync(CFG.tracesDir);
  eq(files.length, before + 1, "one new trace");
  const trace = JSON.parse(fs.readFileSync(path.join(CFG.tracesDir, `${out.run_id}.json`), "utf-8"));
  eq(trace.result.status, "blocked", "status recorded");
  assert(trace.steps.length >= 1, "the step that produced it is recorded");
});

await check("the sensitive gate stops BEFORE the browser is touched", async () => {
  // The important assertion is not the status, it is that no computer or
  // form_input call was ever made.
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Delete everything" })] });
  const client = fakeClient([{ operation: choice("CLICK", 0.99), target: choice("e1", 0.99), sensitive: noul(0.99) }]);
  const out = await navigate(browser.callTool, client, CFG, { tabId: 1, goal: "clean up", success_criteria: "done" });
  eq(out.status, "needs_help", "status");
  assert(!browser.calls.some((c) => c.name === "computer" || c.name === "form_input"), "an action was performed despite the gate");
});

await check("needs_value stops without acting and says what is missing", async () => {
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "textbox", name: "Search", type: "search" })] });
  const client = fakeClient([{ operation: choice("TYPE_TEXT", 0.95), target: choice("e1", 0.95), sensitive: noul(0), value_key: choice("NONE", 0.9) }]);
  const out = await navigate(browser.callTool, client, CFG, { tabId: 1, goal: "search", success_criteria: "results", values: { unrelated: "x" } });
  eq(out.status, "needs_value", "status");
  assert(out.reason.includes("Search"), "names the field");
  assert(!browser.calls.some((c) => c.name === "form_input"), "nothing was typed");
});

await check("a blocked domain sends nothing to the provider at all", async () => {
  // Domain gating has to happen before the decision, not after: the point is
  // that the page never reaches OpenRouter, not that we ignore the answer.
  const browser = fakeBrowser({ url: "https://bank.test/x", rows: [row({ ref: "ref_1", role: "button", name: "Go" })] });
  const client = fakeClient([{ operation: choice("CLICK", 0.95), target: choice("e1", 0.95), sensitive: noul(0) }]);
  const cfg = { ...CFG, blockedDomains: ["bank.test"] };
  const out = await navigate(browser.callTool, client, cfg, { tabId: 1, goal: "g", success_criteria: "s" });
  eq(out.status, "blocked", "status");
  eq(client.seen.length, 0, "no Jev request was made");
});

await check("an allowlist permits its own subdomains and refuses everything else", async () => {
  const cfg = { ...CFG, allowedDomains: ["app.test"] };
  const ok = fakeBrowser({ url: "https://sub.app.test/x", rows: [row({ ref: "ref_1", role: "button", name: "Go" })] });
  const okClient = fakeClient([{ operation: choice("BLOCKED", 0.9), sensitive: noul(0) }]);
  eq((await navigate(ok.callTool, okClient, cfg, { tabId: 1, goal: "g", success_criteria: "s" })).status, "blocked", "reached the decision (BLOCKED came from Jev)");
  eq(okClient.seen.length, 1, "subdomain was allowed through");

  const no = fakeBrowser({ url: "https://other.test/x", rows: [row({ ref: "ref_1", role: "button", name: "Go" })] });
  const noClient = fakeClient([{ operation: choice("CLICK", 0.9), target: choice("e1", 0.9), sensitive: noul(0) }]);
  await navigate(no.callTool, noClient, cfg, { tabId: 1, goal: "g", success_criteria: "s" });
  eq(noClient.seen.length, 0, "an off-list domain never reached the provider");
});

await check("two steps that change nothing hand back rather than grinding to the cap", async () => {
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Go" })] });
  const client = fakeClient([
    { operation: choice("SCROLL_DOWN", 0.9), sensitive: noul(0) },
    { operation: choice("SCROLL_UP", 0.9), sensitive: noul(0) },
    { operation: choice("SCROLL_DOWN", 0.9), sensitive: noul(0) }
  ]);
  const out = await navigate(browser.callTool, client, CFG, { tabId: 1, goal: "g", success_criteria: "s" });
  eq(out.status, "needs_help", "status");
  assert(out.reason.includes("unchanged"), `reason should name the cause: ${out.reason}`);
  assert(out.steps.length < CFG.maxSteps, "bailed early");
});

await check("an oscillation is caught even though the page changes every step", async () => {
  // The case the no-progress check cannot see: clicking a toggle opens a
  // dropdown, clicking it again closes it. The page differs on every single
  // step, so no two consecutive observations match — but the run keeps
  // returning to the same state and is going nowhere.
  let open = false;
  const browser = fakeBrowser({
    rows: [row({ ref: "ref_1", role: "button", name: "Filter" })],
    onClick: (s) => {
      open = !open;
      s.title = open ? "Filter open" : "Filter closed";
      s.rows = open
        ? [row({ ref: "ref_1", role: "button", name: "Filter" }), row({ ref: "ref_2", role: "option", name: "Last 30 days" })]
        : [row({ ref: "ref_1", role: "button", name: "Filter" })];
    }
  });
  const client = fakeClient([{ operation: choice("CLICK", 0.95), target: choice("e1", 0.95), sensitive: noul(0) }]);
  const out = await navigate(browser.callTool, client, CFG, { tabId: 1, goal: "g", success_criteria: "s" });
  eq(out.status, "needs_help", `status (reason: ${out.reason})`);
  assert(out.reason.includes("three times"), `reason: ${out.reason}`);
  assert(out.steps.length < CFG.maxSteps, "bailed before the cap");
});

await check("a repeated action that keeps working is not mistaken for a loop", async () => {
  // Paging through a list re-clicks "Next" at the same ref on every page,
  // because the renderer restarts refs at ref_1 on each load. The action key is
  // identical every time and the loop is working perfectly, so only repetition
  // that changes nothing may trip the guard.
  let n = 0;
  const browser = fakeBrowser({
    rows: [row({ ref: "ref_1", role: "button", name: "Next" })],
    onClick: (s) => { s.url = `https://app.test/page/${++n}`; s.title = `Page ${n}`; }
  });
  const client = fakeClient([{ operation: choice("CLICK", 0.95), target: choice("e1", 0.95), sensitive: noul(0) }]);
  const out = await navigate(browser.callTool, client, CFG, { tabId: 1, goal: "g", success_criteria: "s", max_steps: 5 });
  eq(out.status, "limit_reached", `should run to the cap, not bail: ${out.reason}`);
  eq(out.steps.length, 5, "all five steps ran");
});

await check("max_steps is honoured and cannot be raised past the config cap", async () => {
  let n = 0;
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Next" })], onClick: (s) => { s.url = `https://app.test/${++n}`; } });
  const client = fakeClient([(state) => ({ operation: choice("CLICK", 0.95), target: choice("e1", 0.95), sensitive: noul(0) })]);
  const out = await navigate(browser.callTool, client, CFG, { tabId: 1, goal: "g", success_criteria: "s", max_steps: 3 });
  eq(out.status, "limit_reached", "status");
  eq(out.steps.length, 3, "exactly three steps");

  const out2 = await navigate(browser.callTool, fakeClient([{ operation: choice("BLOCKED", 0.9), sensitive: noul(0) }]), { ...CFG, maxSteps: 2 }, { tabId: 1, goal: "g", success_criteria: "s", max_steps: 999 });
  assert(out2.status === "blocked", "the caller cannot raise the ceiling");
});

await check("a DONE the page does not support keeps going instead of being believed", async () => {
  // This is the case success_criteria exists for: the model claiming victory.
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Go" })] });
  const client = fakeClient([
    { operation: choice("DONE", 0.95), sensitive: noul(0) },
    { satisfied: noul(0.05) },
    { operation: choice("DONE", 0.95), sensitive: noul(0) },
    { satisfied: noul(0.05) }
  ]);
  const out = await navigate(browser.callTool, client, CFG, { tabId: 1, goal: "g", success_criteria: "an invoice is shown" });
  eq(out.status, "needs_help", "status");
  assert(out.reason.includes("DONE"), `reason: ${out.reason}`);
});

await check("start_url navigates before the first decision, and only Claude can", async () => {
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Go" })] });
  const client = fakeClient([{ operation: choice("BLOCKED", 0.9), sensitive: noul(0) }]);
  await navigate(browser.callTool, client, CFG, { tabId: 1, goal: "g", success_criteria: "s", start_url: "https://app.test/start" });
  const navs = browser.calls.filter((c) => c.name === "navigate");
  eq(navs.length, 1, "exactly one navigation");
  eq(navs[0].args.url, "https://app.test/start", "to the requested url");
  assert(browser.calls.indexOf(navs[0]) === 0, "before any observation");
});

await check("a browser error stops the run instead of deciding on a blank page", async () => {
  const callTool = async (name) =>
    name === "read_page"
      ? { content: [{ type: "text", text: "Error: no browser bridge" }] }
      : { content: [{ type: "text", text: "{}" }] };
  const client = fakeClient([{ operation: choice("CLICK", 0.9), sensitive: noul(0) }]);
  const out = await navigate(callTool, client, CFG, { tabId: 1, goal: "g", success_criteria: "s" });
  eq(out.status, "blocked", "status");
  eq(client.seen.length, 0, "no decision was attempted");
});

await check("jev_decide proposes without acting", async () => {
  const browser = fakeBrowser({ rows: [row({ ref: "ref_1", role: "button", name: "Search" })] });
  const client = fakeClient([{ operation: choice("CLICK", 0.9), target: choice("e1", 0.88), sensitive: noul(0.02) }]);
  const out = await decideOnce(browser.callTool, client, CFG, { tabId: 1, goal: "g", success_criteria: "s" });
  eq(out.status, "proposed", "status");
  eq(out.operation, "CLICK", "operation");
  eq(out.target_ref, "ref_1", "target");
  assert(out.probabilities.operation, "the distribution is returned for inspection");
  assert(!browser.calls.some((c) => c.name === "computer" || c.name === "form_input"), "nothing was executed");
});

try {
  fs.rmSync(CFG.tracesDir, { recursive: true, force: true });
} catch {}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);

#!/usr/bin/env node
//
// The read_page("interactive") line grammar.
//
// This parser reads output produced by generateAccessibilityTree() in
// extension/content.js, across a process boundary, with no schema between them.
// The cases here are the ones where a naive split-on-spaces parser is wrong:
// an element with no role, an element with no accessible name, a name that
// itself contains a quote or a bracket, and a <select> whose options carry both
// commas and quotes. Each is emitted by the renderer as written; none is
// hypothetical.
//
// Run: node host/test/jev-parse.test.mjs

import {
  parseLine,
  parsePage,
  usableRows,
  parseTabContext,
  isToolError,
  observationSignature
} from "../jev/observe.js";

const results = [];
function check(name, fn) {
  try {
    fn();
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

check("role + name + ref", () => {
  const r = parseLine('link "Invoices" [ref_12]');
  eq(r.role, "link", "role");
  eq(r.name, "Invoices", "name");
  eq(r.ref, "ref_12", "ref");
});

check("role omitted — line opens straight at the quote", () => {
  // content.js emits `${indent}` then `if (role)`, so with no role the line is
  // indent + ' "name"'. The leading space is real, not a formatting slip.
  const r = parseLine('  "Continue" [ref_3]');
  eq(r.role, "", "role should be empty");
  eq(r.name, "Continue", "name");
  eq(r.ref, "ref_3", "ref");
});

check("name omitted — ref is the only guaranteed field", () => {
  const r = parseLine("  button [ref_7]");
  eq(r.role, "button", "role");
  eq(r.name, "", "name should be empty");
  eq(r.ref, "ref_7", "ref");
});

check("neither role nor name", () => {
  const r = parseLine('   [ref_9] href="https://x.test/a"');
  eq(r.role, "", "role");
  eq(r.name, "", "name");
  eq(r.ref, "ref_9", "ref");
  eq(r.href, "https://x.test/a", "href");
});

check("link attributes", () => {
  const r = parseLine('link "Docs" [ref_2] href="https://x.test/docs#ref_9"');
  eq(r.ref, "ref_2", "must not pick the ref_9 inside the href");
  eq(r.href, "https://x.test/docs#ref_9", "href");
});

check("a name containing a bracketed ref does not hijack the ref", () => {
  const r = parseLine('button "Delete [ref_1]" [ref_44]');
  eq(r.ref, "ref_44", "ref");
  eq(r.name, "Delete [ref_1]", "name");
});

check("a name containing a quote", () => {
  // The renderer does not escape quotes inside the accessible name, so the
  // closing quote has to be the last one before the ref, not the first.
  const r = parseLine('button "Say \"hi\"" [ref_5]');
  eq(r.ref, "ref_5", "ref");
  assert(r.name.startsWith("Say"), `name got truncated at the inner quote: ${r.name}`);
});

check("input with value and type", () => {
  const r = parseLine('textbox "Search" [ref_4] value="shoes" type="search"');
  eq(r.value, "shoes", "value");
  eq(r.type, "search", "type");
});

check("aria flags parse as booleans", () => {
  const r = parseLine('button "Menu" [ref_8] expanded=false checked=true');
  eq(r.expanded, false, "expanded");
  eq(r.checked, true, "checked");
});

check("disabled is a bare token, not a key=value", () => {
  const r = parseLine('button "Submit" [ref_6] type="submit" disabled');
  eq(r.disabled, true, "disabled");
  eq(r.type, "submit", "type");
});

check("select options carry commas and quotes", () => {
  const r = parseLine('combobox "Country" [ref_10] options=[*us="United States",  fr="France, Metropolitan"]');
  eq(r.options.length, 2, "option count");
  eq(r.options[0].value, "us", "first value");
  eq(r.options[0].selected, true, "first is selected");
  eq(r.options[1].label, "France, Metropolitan", "a label containing a comma survives");
  eq(r.options[1].selected, false, "second is not selected");
});

check("non-element lines are skipped, not guessed at", () => {
  assert(parseLine("") === null, "empty line");
  assert(parseLine("   ") === null, "whitespace line");
  assert(parseLine("some prose with no ref") === null, "prose");
});

check("truncation marker is detected and not parsed as a row", () => {
  const page = parsePage('link "A" [ref_1]\nbutton "B" [ref_2]\n... (truncated)');
  assert(page.truncated, "should flag truncation");
  eq(page.rows.length, 2, "row count");
});

check("usableRows drops disabled controls", () => {
  const { rows } = parsePage('button "Go" [ref_1]\nbutton "Nope" [ref_2] disabled');
  const usable = usableRows(rows);
  eq(usable.length, 1, "one usable row");
  eq(usable[0].ref, "ref_1", "kept the enabled one");
});

check("usableRows collapses indistinguishable duplicates", () => {
  // Two rows Jev could not tell apart would split the probability mass between
  // them and push confidence under the gate for no reason.
  const { rows } = parsePage('link "Next" [ref_1] href="https://x.test/2"\nlink "Next" [ref_2] href="https://x.test/2"');
  eq(usableRows(rows).length, 1, "deduped");
});

check("callTool failures are text, not exceptions", () => {
  // host/tool-runtime.js L268-270 turns every error into a text block prefixed
  // "Error: " and never sets isError, so the prefix is the only signal there is.
  assert(isToolError({ content: [{ type: "text", text: "Error: no bridge" }] }), "should detect");
  assert(!isToolError({ content: [{ type: "text", text: 'link "A" [ref_1]' }] }), "should not false-positive");
});

check("tabs_context_mcp JSON prefix yields url and title", () => {
  const text =
    JSON.stringify({ availableTabs: [{ tabId: 5, title: "Billing", url: "https://app.x.test/billing" }], tabGroupId: 1 }) +
    "\n\nTab Context:\n- Available tabs:\n  • tabId 5: \"Billing\" (https://app.x.test/billing)\n";
  const ctx = parseTabContext(text, 5);
  eq(ctx.url, "https://app.x.test/billing", "url");
  eq(ctx.title, "Billing", "title");
  assert(parseTabContext(text, 99) === null, "unknown tab id yields null");
});

check("observationSignature changes when a field value changes", () => {
  const a = { url: "u", title: "t", rows: [{ role: "textbox", name: "Search", value: "" }] };
  const b = { url: "u", title: "t", rows: [{ role: "textbox", name: "Search", value: "shoes" }] };
  assert(observationSignature(a) !== observationSignature(b), "typing must count as progress");
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exit(failed.length ? 1 : 0);

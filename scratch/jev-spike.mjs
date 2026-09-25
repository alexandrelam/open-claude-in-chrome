#!/usr/bin/env node
//
// M0 spike: one real Jev decision against a real tab, printed with its timings
// and its exact cost.
//
// This is the thing to run first on a new site, and the thing to run when a
// jev_navigate result looks wrong — it shows the state that was sent, the full
// probability distribution, and what the gate would have done, without touching
// the page.
//
// Usage:
//   OPENROUTER_API_KEY=sk-or-... node scratch/jev-spike.mjs <tabId> "<goal>" ["<success criteria>"]
//
// Find a tabId with the tabs_context_mcp tool, or start one with
// tabs_context_mcp({ createIfEmpty: true }).

import { init, callTool, shutdown } from "../host/tool-runtime.js";
import { resolveConfig, configError } from "../host/jev/config.js";
import { createClient } from "../host/jev/client.js";
import { observe } from "../host/jev/observe.js";
import { buildRequest, validate } from "../host/jev/navigator.js";
import { estimateTokens, JEV_CONTEXT_TOKENS, shortlistRows } from "../host/jev/shortlist.js";
import { rowLabel } from "../host/jev/actions.js";

const [tabIdRaw, goal, criteria] = process.argv.slice(2);
if (!tabIdRaw || !goal) {
  console.error('usage: node scratch/jev-spike.mjs <tabId> "<goal>" ["<success criteria>"]');
  process.exit(2);
}
const tabId = Number(tabIdRaw);
const successCriteria = criteria || `${goal} has been accomplished`;

const cfg = resolveConfig();
const err = configError(cfg);
if (err) {
  console.error(err);
  process.exit(2);
}

await init();

const t0 = Date.now();
const obs = await observe(callTool, tabId);
const observeMs = Date.now() - t0;

if (obs.error) {
  console.error(`could not read the tab: ${obs.error}`);
  shutdown();
  process.exit(1);
}

const client = createClient(cfg);
const short = await shortlistRows(obs.rows, {
  goal, successCriteria, maxRows: cfg.maxRows, decide: (s, q) => client.decide(s, q)
});
const { state, questions, idMap } = buildRequest(obs, short.rows, { goal, successCriteria, values: {} });

const stateTokens = estimateTokens(state);
const t1 = Date.now();
const { answers, usage, model } = await client.decide(state, questions);
const jevMs = Date.now() - t1;

const verdict = validate(answers, idMap, cfg, { allowSensitive: false, values: {} });

const pct = (o) =>
  Object.entries(o ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`)
    .join("  ");

console.log(`
page       ${obs.title} — ${obs.url}
rows       ${obs.allRows.length} parsed, ${obs.rows.length} usable, ${short.rows.length} offered${short.cut ? `, ${short.cut} cut` : ""}${obs.truncated ? " (read_page TRUNCATED)" : ""}
state      ~${stateTokens} tokens of the ${JEV_CONTEXT_TOKENS} window (${((stateTokens / JEV_CONTEXT_TOKENS) * 100).toFixed(1)}%)
model      ${model}
timing     observe ${observeMs}ms   jev ${jevMs}ms
cost       $${(usage.cost ?? 0).toFixed(6)}${short.scored ? " (includes the section-scoring pass)" : ""}

operation  ${answers.operation?.choice}  (confidence ${answers.operation?.confidence?.toFixed(2)})
           ${pct(answers.operation?.probabilities)}
target     ${verdict.row ? rowLabel(verdict.row) : answers.target?.choice ?? "-"}  (confidence ${answers.target?.confidence?.toFixed(2) ?? "-"})
           ${pct(answers.target?.probabilities)}
sensitive  p=${answers.sensitive?.noul?.toFixed(2)}

gate       ${verdict.ok ? `WOULD ACT: ${verdict.operation} on ${rowLabel(verdict.row)}` : `WOULD STOP (${verdict.status}): ${verdict.reason}`}
`);

shutdown();

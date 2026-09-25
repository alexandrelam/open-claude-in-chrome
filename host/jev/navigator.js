// The navigator: one Jev decision per browser step, with a deterministic gate
// between the decision and the action.
//
// The division of labour the PRD asks for: Claude plans and supplies text, Jev
// picks one operation and one target per step, this file checks the pick and
// carries it out through the ordinary tools, and the extension performs it in
// the real profile. Jev never sees a selector and never returns one.

import {
  observe,
  observationSignature,
  isToolError,
  resultText
} from "./observe.js";
import {
  OPERATIONS,
  availableOperations,
  isCompatible,
  looksSensitive,
  planToolCalls,
  rowLabel
} from "./actions.js";
import { shortlistRows, renderRow } from "./shortlist.js";
import { createTrace } from "./trace.js";
import { BudgetExceeded } from "./client.js";

const NONE = "NONE";

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function domainAllowed(url, cfg) {
  const host = hostOf(url);
  if (!host) return true;
  const matches = (d) => host === d || host.endsWith(`.${d}`);
  if (cfg.blockedDomains?.some(matches)) return false;
  // null means no allowlist at all. An empty array is an allowlist that permits
  // nothing, which is a legitimate way to switch the loop off for a session.
  if (cfg.allowedDomains === null || cfg.allowedDomains === undefined) return true;
  return cfg.allowedDomains.some(matches);
}

/**
 * Build the Jev request for one step: the state it reasons over and the four
 * questions, which are answered in parallel inside a single round trip.
 *
 * Rows are addressed as e1..eN, not as ref_N. The mapping back to refs stays in
 * this process, so a ref Jev was not offered cannot come back out of it.
 */
export function buildRequest(obs, rows, { goal, successCriteria, values }) {
  const idMap = new Map();
  const elements = rows.map((row, i) => {
    const id = `e${i + 1}`;
    idMap.set(id, row);
    return renderRow(row, id);
  });

  const valueKeys = Object.keys(values || {});
  const ops = availableOperations(rows);

  const state = {
    goal,
    success_criteria: successCriteria,
    url: obs.url,
    title: obs.title,
    page_excerpt: obs.excerpt,
    elements,
    values: valueKeys
  };

  const operationCriteria = {};
  for (const op of ops) operationCriteria[op] = OPERATIONS[op].description;

  const targetCriteria = {};
  for (const [id, row] of idMap) {
    targetCriteria[id] = `${row.role || "element"}: ${row.name || row.href || id}`;
  }

  const questions = {
    operation: {
      type: "choice",
      instructions:
        "What single operation should the browser agent take next to advance the goal? Choose DONE only if the success criteria are already visibly met on this page.",
      criteria: operationCriteria
    }
  };

  // A Choice needs something to choose between. On a page with no usable rows
  // the only sensible operations are the targetless ones, and asking anyway
  // would send an empty criteria object.
  if (idMap.size > 0) {
    questions.target = {
      type: "choice",
      instructions:
        "If the operation acts on an element, which element? Pick the one whose label best matches the next step toward the goal.",
      criteria: targetCriteria
    };
  }

  if (valueKeys.length > 0) {
    const valueCriteria = { [NONE]: "None of the provided values belongs in this field" };
    for (const k of valueKeys) valueCriteria[k] = `The value provided under "${k}"`;
    questions.value_key = {
      type: "choice",
      instructions:
        "If the operation types or selects, which provided value belongs in the target field?",
      criteria: valueCriteria
    };
  }

  questions.sensitive = {
    type: "noul",
    instructions:
      "Would performing this action have a destructive, financial or otherwise irreversible effect?",
    criteria: {
      true: "It pays, deletes, sends, publishes, submits or otherwise commits something that cannot simply be undone",
      false: "It only navigates, reads, filters or fills in a field, and is safe to undo"
    }
  };

  return { state, questions, idMap };
}

/**
 * Apply every deterministic check to Jev's answers.
 *
 * Never skipped, and deliberately ordered so the cheapest structural failures
 * (unknown operation, unknown ref) are caught before the judgement calls.
 */
export function validate(answers, idMap, cfg, { allowSensitive, values }) {
  const opAns = answers.operation;
  if (!opAns?.choice || !OPERATIONS[opAns.choice]) {
    return { ok: false, status: "needs_help", reason: `Jev returned an unknown operation: ${opAns?.choice}` };
  }
  const operation = opAns.choice;
  const spec = OPERATIONS[operation];

  if (operation === "BLOCKED") {
    return { ok: false, status: "blocked", operation, reason: "Jev reports no offered operation can advance the goal from this page." };
  }

  let row = null;
  let confidence = opAns.confidence;

  if (spec.needsTarget) {
    const targetAns = answers.target;
    row = targetAns?.choice ? idMap.get(targetAns.choice) : null;
    if (!row) {
      return { ok: false, status: "needs_help", operation, reason: `Jev chose target "${targetAns?.choice}", which is not in this observation.` };
    }
    if (!isCompatible(operation, row)) {
      return { ok: false, status: "needs_help", operation, reason: `Operation ${operation} is not valid on ${rowLabel(row)}.` };
    }
    // The step is only as certain as its least certain half: a confident
    // operation aimed at a coin-flip target is not a confident action.
    confidence = Math.min(confidence, targetAns.confidence);
  }

  if (confidence < cfg.minConfidence) {
    return {
      ok: false, status: "needs_help", operation, row, confidence,
      reason: `Confidence ${confidence.toFixed(2)} is below the ${cfg.minConfidence} threshold for ${operation} on ${rowLabel(row)}.`
    };
  }

  const sensitiveByModel = (answers.sensitive?.noul ?? 0) > cfg.sensitiveThreshold;
  const sensitiveByLabel = looksSensitive(row);
  if ((sensitiveByModel || sensitiveByLabel) && !allowSensitive) {
    return {
      ok: false, status: "needs_help", operation, row, confidence, sensitive: true,
      reason: `Refusing a possibly irreversible action: ${operation} on ${rowLabel(row)} (model p=${(answers.sensitive?.noul ?? 0).toFixed(2)}${sensitiveByLabel ? ", label matched a sensitive keyword" : ""}). Re-run with allow_sensitive: true, or do this step yourself.`
    };
  }

  let value;
  if (spec.needsValue) {
    const key = answers.value_key?.choice;
    if (!key || key === NONE || !(key in (values || {}))) {
      return {
        ok: false, status: "needs_value", operation, row, confidence,
        reason: `${operation} needs a value for ${rowLabel(row)} (role ${row?.role || "unknown"}${row?.type ? `, type ${row.type}` : ""}), and none of the provided values fits. Supply one in \`values\` and call again.`
      };
    }
    value = String(values[key]);
  }

  return { ok: true, operation, row, value, confidence, sensitive: sensitiveByModel || sensitiveByLabel };
}

async function observeOrFail(callTool, tabId, cfg) {
  const obs = await observe(callTool, tabId);
  if (obs.error) return { obs: null, failure: { status: "blocked", reason: obs.error } };
  if (!domainAllowed(obs.url, cfg)) {
    return {
      obs,
      failure: {
        status: "blocked",
        reason: `${hostOf(obs.url)} is outside the configured jev.allowed_domains / blocked in jev.blocked_domains, so no page content was sent and no action was taken.`
      }
    };
  }
  return { obs, failure: null };
}

/** One observation + one decision, with no action. Backs the jev_decide tool. */
export async function decideOnce(callTool, client, cfg, args) {
  const { tabId, goal, success_criteria: successCriteria, values, allow_sensitive } = args;
  const { obs, failure } = await observeOrFail(callTool, tabId, cfg);
  if (failure) return { status: failure.status, reason: failure.reason };

  const short = await shortlistRows(obs.rows, {
    goal, successCriteria, maxRows: cfg.maxRows,
    decide: (s, q) => client.decide(s, q)
  });
  const { state, questions, idMap } = buildRequest(obs, short.rows, { goal, successCriteria, values });
  const { answers, ms, usage } = await client.decide(state, questions);
  const verdict = validate(answers, idMap, cfg, { allowSensitive: allow_sensitive, values });

  return {
    status: verdict.ok ? "proposed" : verdict.status,
    operation: verdict.operation ?? answers.operation?.choice,
    target_ref: verdict.row?.ref ?? null,
    target_label: rowLabel(verdict.row),
    value: verdict.value,
    confidence: verdict.confidence ?? answers.operation?.confidence ?? null,
    sensitive_probability: answers.sensitive?.noul ?? null,
    reason: verdict.ok ? null : verdict.reason,
    probabilities: {
      operation: answers.operation?.probabilities ?? {},
      target: answers.target?.probabilities ?? {}
    },
    rows_offered: short.rows.length,
    rows_cut: short.cut,
    truncated: obs.truncated,
    url: obs.url,
    title: obs.title,
    jev_ms: ms,
    usage
  };
}

/** The full loop. Backs the jev_navigate tool. */
export async function navigate(callTool, client, cfg, args) {
  const {
    tabId, goal, success_criteria: successCriteria, values = {},
    start_url: startUrl, allow_sensitive: allowSensitive = false
  } = args;

  const maxSteps = Math.min(args.max_steps ?? cfg.maxSteps, cfg.maxSteps);
  const maxMs = args.max_ms ?? cfg.maxMs;
  const minConfidence = args.min_confidence ?? cfg.minConfidence;
  const runCfg = { ...cfg, minConfidence };

  const deadline = Date.now() + maxMs;
  const trace = createTrace(cfg.tracesDir, {
    goal, success_criteria: successCriteria, tab_id: tabId,
    model: cfg.model, max_steps: maxSteps, max_ms: maxMs,
    min_confidence: minConfidence, allow_sensitive: allowSensitive,
    value_keys: Object.keys(values)
  });

  const steps = [];
  let obs = null;
  let lastSignature = null;
  let unchangedStreak = 0;
  const actionCounts = new Map();

  const finish = (status, reason) => {
    const out = {
      status,
      steps,
      final_url: obs?.url ?? "",
      final_title: obs?.title ?? "",
      reason: reason ?? null,
      // The final page, so Claude can carry on without spending a turn on
      // read_page just to find out where the loop left the tab.
      page_excerpt: obs
        ? {
            url: obs.url, title: obs.title, text: obs.excerpt,
            interactive: obs.rows.slice(0, 40).map((r, i) => renderRow(r, `e${i + 1}`))
          }
        : null,
      usage: client.totals,
      run_id: trace.runId
    };
    trace.finish({ status, reason: reason ?? null, final_url: out.final_url }, client.totals);
    return out;
  };

  // Only Claude navigates. `navigate` is not in the action space, so this is
  // the single point at which the loop can change the URL, and it happens
  // before any Jev call.
  if (startUrl) {
    const res = await callTool("navigate", { url: startUrl, tabId });
    if (isToolError(res)) return finish("blocked", resultText(res));
  }

  for (let i = 1; i <= maxSteps; i++) {
    if (Date.now() > deadline) return finish("limit_reached", `Time limit of ${maxMs}ms reached after ${i - 1} steps.`);

    const stepStart = Date.now();
    const { obs: fresh, failure } = await observeOrFail(callTool, tabId, runCfg);
    if (failure) {
      if (fresh) obs = fresh;
      return finish(failure.status, failure.reason);
    }
    obs = fresh;

    let short, request, answers, jevMs, verdict;
    try {
      short = await shortlistRows(obs.rows, {
        goal, successCriteria, maxRows: runCfg.maxRows,
        decide: (s, q) => client.decide(s, q)
      });
      request = buildRequest(obs, short.rows, { goal, successCriteria, values });
      const res = await client.decide(request.state, request.questions);
      answers = res.answers;
      jevMs = res.ms;
    } catch (err) {
      if (err instanceof BudgetExceeded) return finish("limit_reached", err.message);
      return finish("needs_help", `Jev request failed: ${err?.message ?? err}`);
    }

    verdict = validate(answers, request.idMap, runCfg, { allowSensitive, values });

    trace.step({
      i, url: obs.url, title: obs.title,
      rows_offered: short.rows.length, rows_cut: short.cut, truncated: obs.truncated,
      answers, verdict: { ok: verdict.ok, status: verdict.status ?? null, reason: verdict.reason ?? null },
      operation: verdict.operation, target_ref: verdict.row?.ref ?? null,
      jev_ms: jevMs
    });

    if (!verdict.ok) return finish(verdict.status, verdict.reason);

    if (verdict.operation === "DONE") {
      // Ask against a fresh observation rather than the one that produced the
      // DONE: the point of the check is that the page, not the model's memory
      // of its own last action, satisfies the criteria.
      const { obs: confirmObs } = await observeOrFail(callTool, tabId, runCfg);
      if (confirmObs) obs = confirmObs;
      const { answers: check } = await client.decide(
        { url: obs.url, title: obs.title, page_excerpt: obs.excerpt, goal,
          elements: obs.rows.slice(0, runCfg.maxRows).map((r, k) => renderRow(r, `e${k + 1}`)) },
        {
          satisfied: {
            type: "noul",
            instructions: `Are these success criteria met on this page: ${successCriteria}`,
            criteria: { true: "The criteria are visibly satisfied by what is on this page", false: "They are not yet satisfied" }
          }
        }
      );
      const p = check.satisfied?.noul ?? 0;
      steps.push({ i, operation: "DONE", target_ref: null, target_label: "", confidence: check.satisfied?.confidence ?? 0, ms: Date.now() - stepStart });
      if (p > 0.5) return finish("done", null);
      // Jev said done, the page says otherwise. Carry on rather than trusting
      // the claim — this is the case the success criteria exist to catch.
      unchangedStreak++;
      if (unchangedStreak >= 2) return finish("needs_help", `Jev reported DONE but the success criteria are not met (p=${p.toFixed(2)}).`);
      continue;
    }

    // Key the repeat guard on the action AND the page it was taken from.
    //
    // Keying on the action alone cannot tell two opposite situations apart.
    // Paging through a list re-clicks "Next" at the same ref on every page —
    // the renderer restarts refs at ref_1 on each load — so the action key is
    // identical every time while the loop works perfectly. An oscillation
    // (click Filter, dropdown opens; click Filter, dropdown closes) also
    // changes the page every step, so the no-progress check never fires on it
    // either. Including the originating page separates them: paging starts each
    // click from a new state, oscillating keeps returning to the same one.
    const actionKey = `${observationSignature(obs)}|${verdict.operation}:${verdict.row?.ref ?? "-"}:${verdict.value ?? ""}`;
    const count = (actionCounts.get(actionKey) ?? 0) + 1;
    actionCounts.set(actionKey, count);
    if (count > 2) {
      return finish("needs_help", `The same action (${verdict.operation} on ${rowLabel(verdict.row)}) came up three times without progress.`);
    }

    // Act. A ref can go stale between the observation and here — the Jev call
    // sits in between — so a ref failure re-observes and retries the same
    // operation once against the row that now carries that label.
    let acted = await runCalls(callTool, planToolCalls(verdict.operation, verdict.row, verdict.value, tabId));
    if (acted.error && /ref_\d+|not found|garbage collected/i.test(acted.error)) {
      const { obs: retryObs } = await observeOrFail(callTool, tabId, runCfg);
      const again = retryObs?.rows.find(
        (r) => r.role === verdict.row.role && r.name === verdict.row.name
      );
      if (again) {
        acted = await runCalls(callTool, planToolCalls(verdict.operation, again, verdict.value, tabId));
      }
    }
    if (acted.error) return finish("needs_help", `The action failed: ${acted.error}`);

    steps.push({
      i, operation: verdict.operation, target_ref: verdict.row?.ref ?? null,
      target_label: rowLabel(verdict.row), confidence: Number(verdict.confidence.toFixed(3)),
      ms: Date.now() - stepStart
    });

    // Verify: did anything move? Compared against the observation taken at the
    // TOP of the next iteration, so this only records the signature.
    const { obs: after } = await observeOrFail(callTool, tabId, runCfg);
    const sig = observationSignature(after);
    if (lastSignature !== null && sig === lastSignature) {
      unchangedStreak++;
      if (unchangedStreak >= 2) {
        obs = after ?? obs;
        return finish("needs_help", `Two steps in a row left the page unchanged after ${verdict.operation} on ${rowLabel(verdict.row)}.`);
      }
    } else {
      unchangedStreak = 0;
    }
    lastSignature = sig;
    if (after) obs = after;
  }

  return finish("limit_reached", `Step limit of ${maxSteps} reached.`);
}

async function runCalls(callTool, calls) {
  for (const [name, args] of calls) {
    const res = await callTool(name, args);
    if (isToolError(res)) return { error: resultText(res) };
  }
  return { error: null };
}

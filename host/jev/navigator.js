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
  rowLabel,
  SUBMITTING_OPERATIONS
} from "./actions.js";
import { shortlistRows, renderRow } from "./shortlist.js";
import { MAX_CHOICES } from "./config.js";
import { createTrace } from "./trace.js";
import { BudgetExceeded } from "./client.js";

const NONE = "NONE";

/**
 * Will activating this href replace the document?
 *
 * A same-page fragment does not navigate; anything else does. Used to decide
 * what "the action landed" means for a CLICK — see the settle check below.
 */
export function navigatesAway(href, currentUrl) {
  if (!href) return false;
  try {
    const target = new URL(href, currentUrl);
    const here = new URL(currentUrl);
    return (
      target.origin !== here.origin ||
      target.pathname !== here.pathname ||
      target.search !== here.search
    );
  } catch {
    return false;
  }
}

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
  // Last line of defence against the provider's 255-option ceiling. The config
  // clamp normally keeps us well under it; this makes a malformed request
  // impossible to construct even from a caller that built its own cfg.
  const capped = rows.slice(0, MAX_CHOICES);
  const elements = capped.map((row, i) => {
    const id = `e${i + 1}`;
    idMap.set(id, row);
    return renderRow(row, id);
  });

  const valueKeys = Object.keys(values || {});
  const ops = availableOperations(capped);

  // `elements` looks like a duplicate of the target question's criteria and is
  // not. Removing it to halve the payload was tried and reverted on 2026-09-25:
  // the criteria only describe the options for the TARGET question, so the
  // state listing is the only page context the OPERATION question ever sees.
  // Without it Jev picked TYPE_TEXT three times in a row on a field it had
  // already filled, and a task that had been finishing in four steps escalated.
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

  // renderRow is the single row renderer, so what Jev chooses between carries
  // the same detail the state listing used to add (value, type, options).
  const targetCriteria = {};
  for (const [id, row] of idMap) targetCriteria[id] = renderRow(row, id);

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

  // Asked on every step, not only when Jev volunteers DONE.
  //
  // Questions in one Decisions request are evaluated in parallel, so this costs
  // essentially nothing — and it removes two round trips per task: the step Jev
  // used to spend choosing DONE, and the separate confirmation request that
  // followed it. On a 4-step task those were 2 of the 5 Jev requests.
  //
  // It also means completion is noticed the moment it happens, including when
  // the goal is already met on arrival.
  questions.satisfied = {
    type: "noul",
    instructions: `Judging only by what is on this page right now, are these success criteria met: ${successCriteria}`,
    criteria: {
      true: "The criteria are visibly satisfied by the current page",
      false: "They are not satisfied yet"
    }
  };

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
    // Score the target against the options that are LEGAL for the chosen
    // operation, not against every row on the page.
    //
    // The target question is asked in parallel with the operation question, so
    // its criteria list every row — including ones the chosen operation could
    // never act on. That mass was being counted as doubt. Measured on
    // Wikipedia: PRESS_ENTER put 0.58 on the search field and 0.41 on the
    // Search *button*, which is not a legal PRESS_ENTER target at all; the pair
    // dragged the action to 0.56 and escalated a run that was going perfectly.
    // Conditioned on having chosen PRESS_ENTER, the field is ~0.97.
    //
    // This is not a loosened gate. It is the number meaning what it always
    // claimed to: how sure we are of the target, given the operation.
    const probs = targetAns.probabilities || {};
    let legalMass = 0;
    for (const [id, candidate] of idMap) {
      if (isCompatible(operation, candidate)) legalMass += probs[id] ?? 0;
    }
    const chosenMass = probs[targetAns.choice] ?? 0;
    // If almost all the mass sits on targets the chosen operation cannot act
    // on, the two answers disagree about what is happening on this page.
    // Renormalizing would turn that into a confident 1.0, so the coherence of
    // the pair caps the result rather than being divided away.
    const COHERENCE_FLOOR = 0.25;
    const targetConfidence =
      legalMass <= 0
        ? targetAns.confidence
        : legalMass < COHERENCE_FLOOR
          ? Math.min(chosenMass / legalMass, legalMass / COHERENCE_FLOOR)
          : chosenMass / legalMass;

    // The step is only as certain as its least certain half: a confident
    // operation aimed at a coin-flip target is not a confident action.
    confidence = Math.min(confidence, targetConfidence);
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

function topN(probabilities, n) {
  return Object.entries(probabilities ?? {})
    .filter(([, p]) => p > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, p]) => ({ choice: k, p: Number(p.toFixed(3)) }));
}

function topTargets(probabilities, idMap, n) {
  return Object.entries(probabilities ?? {})
    .filter(([, p]) => p > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([id, p]) => {
      const row = idMap.get(id);
      return { ref: row?.ref ?? id, label: rowLabel(row), p: Number(p.toFixed(3)) };
    });
}

/** One observation + one decision, with no action. Backs the jev_decide tool. */
export async function decideOnce(callTool, client, cfg, args) {
  const { tabId, goal, success_criteria: successCriteria, values, allow_sensitive } = args;
  const { obs, failure } = await observeOrFail(callTool, tabId, cfg);
  if (failure) return { status: failure.status, reason: failure.reason };

  const short = await shortlistRows(obs.rows, {
    goal, successCriteria, values, maxRows: cfg.maxRows,
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
    // Top few only, and in refs — the same id space as target_ref above.
    // The full target distribution is ~240 entries of almost entirely zero
    // (about 6KB), keyed eN while target_ref is ref_N, so the two halves of the
    // same answer could not be lined up.
    probabilities: {
      operation: topN(answers.operation?.probabilities, 5),
      target: topTargets(answers.target?.probabilities, idMap, 5)
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

/** Normalise the two input shapes into one list. A bare goal is a list of one. */
export function normalizeSubgoals(args) {
  if (Array.isArray(args.subgoals) && args.subgoals.length) {
    return args.subgoals.map((sg) => ({
      goal: sg.goal,
      successCriteria: sg.success_criteria ?? sg.successCriteria,
      values: sg.values ?? args.values ?? {}
    }));
  }
  return [
    {
      goal: args.goal,
      successCriteria: args.success_criteria ?? args.successCriteria,
      values: args.values ?? {}
    }
  ];
}

/**
 * Run one subgoal to completion, escalation or a limit.
 *
 * `ctx` is shared across the subgoals of a call: it carries the observation
 * (so a subgoal starts from the page the previous one left), the wall-clock
 * deadline, the running step number and the browser/Jev time split.
 */
async function runSubgoal(callTool, client, cfg, sub, opts, ctx) {
  const { tabId, allowSensitive, maxSteps, trace } = opts;
  const { goal, successCriteria, values } = sub;

  const steps = [];
  let lastSignature = null;
  let unchangedStreak = 0;
  const actionCounts = new Map();

  // Observing is read-only and idempotent, so a failure is worth retrying.
  //
  // The post-action observation routinely lands while the page is still
  // navigating, and the content script then answers "Could not generate
  // accessibility tree" — which is not a dead run, it is a page mid-flight.
  // Treating it as terminal ended a task that was otherwise succeeding. A
  // domain refusal is a decision, not a failure, so it is never retried.
  const observeNow = async () => {
    const t = Date.now();
    let r = await observeOrFail(callTool, tabId, cfg);
    for (let attempt = 0; attempt < 2 && r.failure && !r.obs; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
      r = await observeOrFail(callTool, tabId, cfg);
    }
    ctx.browserMs += Date.now() - t;
    return r;
  };

  for (let n = 1; n <= maxSteps; n++) {
    if (Date.now() > ctx.deadline) {
      return { status: "limit_reached", reason: `Time limit reached after ${steps.length} steps of this subgoal.`, steps };
    }
    const stepStart = Date.now();
    // Two counters on purpose: `decisionNo` numbers every Jev decision for the
    // trace, while a step in the result is numbered only when an action is
    // actually taken. The iteration that spots completion makes a decision and
    // performs nothing, and would otherwise leave a gap in the step numbering
    // that Claude reads.
    const i = ++ctx.decisionNo;

    // Reuse the observation taken after the previous action instead of taking
    // the same one again. The loop used to observe twice per step and throw the
    // second away.
    let obs = ctx.obs;
    if (!obs) {
      const { obs: fresh, failure } = await observeNow();
      if (failure) {
        if (fresh) ctx.obs = fresh;
        return { status: failure.status, reason: failure.reason, steps };
      }
      obs = fresh;
    }
    ctx.obs = obs;

    let short, request, answers, jevMs, verdict;
    try {
      short = await shortlistRows(obs.rows, {
        goal, successCriteria, values, maxRows: cfg.maxRows,
        decide: (st, q) => client.decide(st, q)
      });
      request = buildRequest(obs, short.rows, { goal, successCriteria, values });
      const res = await client.decide(request.state, request.questions);
      answers = res.answers;
      jevMs = res.ms;
      ctx.jevMs += jevMs;
    } catch (err) {
      if (err instanceof BudgetExceeded) return { status: "limit_reached", reason: err.message, steps };
      return { status: "needs_help", reason: `Jev request failed: ${err?.message ?? err}`, steps };
    }

    const satisfied = answers.satisfied?.noul ?? 0;
    verdict = validate(answers, request.idMap, cfg, { allowSensitive, values });

    trace.step({
      i, subgoal: goal, url: obs.url, title: obs.title,
      rows_offered: short.rows.length, rows_cut: short.cut, truncated: obs.truncated,
      satisfied, answers,
      verdict: { ok: verdict.ok, status: verdict.status ?? null, reason: verdict.reason ?? null },
      operation: verdict.operation, target_ref: verdict.row?.ref ?? null,
      jev_ms: jevMs
    });

    // The success check now governs completion, so it is tested before the
    // action and before any gate: if the page already satisfies the criteria,
    // there is nothing left to do and nothing to refuse.
    if (satisfied > 0.5) {
      return { status: "done", reason: null, steps, satisfied };
    }

    if (!verdict.ok) return { status: verdict.status, reason: verdict.reason, steps };

    if (verdict.operation === "DONE") {
      // Jev says finished, the page says otherwise — exactly the disagreement
      // success_criteria exists to catch. DONE is now a signal, not a gate.
      steps.push({ i: ++ctx.actionNo, operation: "DONE", target_ref: null, target_label: "", confidence: verdict.confidence, ms: Date.now() - stepStart });
      unchangedStreak++;
      ctx.obs = null;
      if (unchangedStreak >= 2) {
        return { status: "needs_help", reason: `Jev reported DONE but the success criteria are not met (p=${satisfied.toFixed(2)}).`, steps };
      }
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
      return { status: "needs_help", reason: `The same action (${verdict.operation} on ${rowLabel(verdict.row)}) came up three times without progress.`, steps };
    }

    // Act. A ref can go stale between the observation and here — the Jev call
    // sits in between — so a ref failure re-observes and retries the same
    // operation once against the row that now carries that label.
    const actStart = Date.now();
    let acted = await runCalls(callTool, planToolCalls(verdict.operation, verdict.row, verdict.value, tabId));
    if (acted.error && /ref_\d+|not found|garbage collected/i.test(acted.error)) {
      const { obs: retryObs } = await observeNow();
      const again = retryObs?.rows.find(
        (r) => r.role === verdict.row.role && r.name === verdict.row.name
      );
      if (again) {
        acted = await runCalls(callTool, planToolCalls(verdict.operation, again, verdict.value, tabId));
      }
    }
    ctx.browserMs += Date.now() - actStart;
    if (acted.error) return { status: "needs_help", reason: `The action failed: ${acted.error}`, steps };

    steps.push({
      i: ++ctx.actionNo, operation: verdict.operation, target_ref: verdict.row?.ref ?? null,
      target_label: rowLabel(verdict.row), confidence: Number(verdict.confidence.toFixed(3)),
      ms: Date.now() - stepStart
    });

    // Observe once, and keep it: it is both this step's did-anything-move check
    // and the next step's starting observation.
    //
    // Let the action land before judging it. A click or a submit starts a
    // navigation that is still in flight microseconds later, and the browser
    // calls themselves take ~20ms, so reading straight away can catch the old
    // page and conclude nothing happened. The loop used to get this settle time
    // by accident, from the ~400ms Jev round trip of the following step;
    // TYPE_AND_SUBMIT does three calls back to back and removed it, which left
    // a successful search looking like a no-op.
    //
    // Only the unchanged case waits, so a page that already moved costs nothing.
    const before = observationSignature(obs);
    const beforeUrl = obs.url;
    // A submit is judged on the URL: it has already changed the signature by
    // putting text in the field, so the signature can no longer tell us whether
    // the navigation landed. Measured: the submit completes around +300ms, and
    // reading at +0ms caught the old page and looked like a no-op.
    // A click on a link that leaves the page is judged on the URL too.
    //
    // Signature change is the wrong test for it: clicking a link inside a
    // dropdown CLOSES the dropdown, which changes the signature immediately
    // while the navigation is still in flight. The loop then decided on a page
    // that was about to be replaced — twice in one audited run — and the next
    // action could have landed on the incoming page instead.
    //
    // A click with no href, or one that only moves to a fragment, does not
    // navigate, so the signature check stays right for it.
    const expectsNavigation =
      SUBMITTING_OPERATIONS.has(verdict.operation) ||
      (verdict.operation === "CLICK" && navigatesAway(verdict.row?.href, obs.url));

    const settled = (o) =>
      expectsNavigation ? o.url !== beforeUrl : observationSignature(o) !== before;

    let { obs: after, failure: afterFail } = await observeNow();
    for (let settle = 0; settle < 4 && !afterFail && !settled(after); settle++) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      ({ obs: after, failure: afterFail } = await observeNow());
    }
    if (afterFail) {
      if (after) ctx.obs = after;
      return { status: afterFail.status, reason: afterFail.reason, steps };
    }
    const sig = observationSignature(after);
    if (lastSignature !== null && sig === lastSignature) {
      unchangedStreak++;
      if (unchangedStreak >= 2) {
        ctx.obs = after;
        return { status: "needs_help", reason: `Two steps in a row left the page unchanged after ${verdict.operation} on ${rowLabel(verdict.row)}.`, steps };
      }
    } else {
      unchangedStreak = 0;
    }
    lastSignature = sig;
    ctx.obs = after;
  }

  return { status: "limit_reached", reason: `Step limit of ${maxSteps} reached for this subgoal.`, steps };
}

/** The full loop over one or more subgoals. Backs the jev_navigate tool. */
export async function navigate(callTool, client, cfg, args) {
  const { tabId, values = {}, start_url: startUrl, allow_sensitive: allowSensitive = false } = args;

  const subgoals = normalizeSubgoals(args);
  // max_steps bounds each subgoal so one runaway leg cannot eat the whole call;
  // max_ms and the spend cap bound the call as a whole.
  const maxSteps = Math.min(args.max_steps ?? cfg.maxSteps, cfg.maxSteps);
  const maxMs = args.max_ms ?? cfg.maxMs;
  const minConfidence = args.min_confidence ?? cfg.minConfidence;
  const runCfg = { ...cfg, minConfidence };

  const trace = createTrace(cfg.tracesDir, {
    goal: subgoals.map((s) => s.goal).join(" → "),
    subgoals: subgoals.map((s) => ({ goal: s.goal, success_criteria: s.successCriteria })),
    tab_id: tabId, model: cfg.model, max_steps: maxSteps, max_ms: maxMs,
    min_confidence: minConfidence, allow_sensitive: allowSensitive,
    value_keys: Object.keys(values)
  });

  const ctx = { obs: null, deadline: Date.now() + maxMs, decisionNo: 0, actionNo: 0, browserMs: 0, jevMs: 0 };
  const legs = [];
  const allSteps = [];
  let status = "done";
  let reason = null;

  const finish = () => {
    const obs = ctx.obs;
    // A truncated observation is a real possible cause of "nothing here can
    // help": read_page hit its own character cap, so rows were dropped before
    // the prefilter could even rank them. Saying so turns a confidently wrong
    // answer into a legible one — an Octopus article yields 1,412 rows and
    // truncates, and this was only ever recorded in the trace.
    if (status !== "done" && obs?.truncated) {
      reason = `${reason ?? "Stopped."} NOTE: the page was too large to read in full (read_page truncated it), so some controls were never observed and could not be chosen. Try a narrower start_url, or scroll to the relevant part first.`;
    }
    const out = {
      status,
      steps: allSteps,
      subgoals: legs,
      final_url: obs?.url ?? "",
      final_title: obs?.title ?? "",
      reason,
      // The final page, so Claude can carry on without spending a turn on
      // read_page just to find out where the loop left the tab.
      page_excerpt: obs
        ? {
            url: obs.url, title: obs.title, text: obs.excerpt,
            interactive: obs.rows.slice(0, 40).map((r, k) => renderRow(r, `e${k + 1}`))
          }
        : null,
      usage: { ...client.totals, jev_ms: ctx.jevMs, browser_ms: ctx.browserMs },
      run_id: trace.runId
    };
    trace.finish(
      { status, reason, final_url: out.final_url, subgoals: legs.map((l) => ({ goal: l.goal, status: l.status })) },
      out.usage
    );
    return out;
  };

  // Only Claude navigates. `navigate` is not in the action space, so this is
  // the single point at which the loop can change the URL, and it happens
  // before any Jev call.
  if (startUrl) {
    const res = await callTool("navigate", { url: startUrl, tabId });
    if (isToolError(res)) {
      status = "blocked";
      reason = resultText(res);
      return finish();
    }
  }

  const finalCheck = args.final_check ?? args.finalCheck ?? null;

  for (const [idx, sub] of subgoals.entries()) {
    const leg = await runSubgoal(
      callTool, client, runCfg, sub,
      { tabId, allowSensitive, maxSteps, trace },
      ctx
    );
    legs.push({ i: idx + 1, goal: sub.goal, status: leg.status, steps: leg.steps, reason: leg.reason });
    allSteps.push(...leg.steps);
    status = leg.status;
    reason = leg.reason;
    // Stop at the first leg that does not finish, and say which one it was so
    // Claude knows where to pick the task back up.
    if (leg.status !== "done") {
      if (subgoals.length > 1) {
        reason = `Subgoal ${idx + 1} of ${subgoals.length} ("${sub.goal}") stopped: ${leg.reason}`;
      }
      break;
    }
  }

  // Every leg reported done — but a per-leg check only ever asked "is THIS leg
  // finished", on the page as it stood at the time. It cannot notice a setting
  // from leg 2 being silently reset by leg 7, which is exactly what the audited
  // app does: turning on "Split by problem" resets the section style a previous
  // leg had just set. One question against the whole intended end state is the
  // only thing that catches it.
  if (status === "done" && finalCheck) {
    const { obs: finalObs } = await (async () => {
      const t = Date.now();
      const r = await observeOrFail(callTool, tabId, runCfg);
      ctx.browserMs += Date.now() - t;
      return r;
    })();
    if (finalObs) ctx.obs = finalObs;
    try {
      const t = Date.now();
      const { answers } = await client.decide(
        {
          intended_end_state: finalCheck,
          url: ctx.obs?.url,
          title: ctx.obs?.title,
          page_excerpt: ctx.obs?.excerpt,
          elements: (ctx.obs?.rows ?? [])
            .slice(0, runCfg.maxRows)
            .map((r, k) => renderRow(r, `e${k + 1}`))
        },
        {
          verified: {
            type: "noul",
            instructions: `Is ALL of this true of the page right now: ${finalCheck}`,
            criteria: {
              true: "Every part of the intended end state is visibly in place",
              false: "Some part of it is missing, or was undone"
            }
          }
        }
      );
      ctx.jevMs += Date.now() - t;
      const p = answers.verified?.noul ?? 0;
      trace.step({ i: ++ctx.decisionNo, final_check: finalCheck, verified: p, url: ctx.obs?.url });
      if (p <= 0.5) {
        status = "needs_help";
        reason = `Every subgoal finished, but the final check did not hold (p=${p.toFixed(2)}): ${finalCheck}. Something set earlier was probably undone by a later step — inspect the page before treating this as done.`;
      }
    } catch (err) {
      status = "needs_help";
      reason = `Every subgoal finished, but the final check could not be run: ${err?.message ?? err}`;
    }
  }

  return finish();
}

async function runCalls(callTool, calls) {
  for (const [name, args] of calls) {
    const res = await callTool(name, args);
    if (isToolError(res)) return { error: resultText(res) };
  }
  return { error: null };
}

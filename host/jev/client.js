// The only place in this repo that talks to a Jev provider.
//
// Everything about the wire format lives behind decide(state, questions), so
// when the /alpha/ Decisions endpoint changes shape — it is alpha, it will —
// there is exactly one file to fix and one contract test to re-record.
//
// Wire format (verified 2026-09-25):
//   POST {baseUrl}/decisions
//   { model, state, questions: { <key>: { type, instructions, criteria } } }
// Answers come back keyed by the same question keys:
//   noul   -> { type: "noul", noul: 0.98 }
//   choice -> { type: "choice", choice, probabilities: {...}, confidence }
//   score  -> { type: "score", score, legend, probabilities, confidence }
// Questions in one request are evaluated in parallel, so a step asks all four
// of its questions in a single round trip. Output tokens are free; only input
// is billed, and usage.cost gives the exact figure in USD.

export class JevError extends Error {
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = "JevError";
    this.status = status;
    this.retryable = retryable;
  }
}

export class BudgetExceeded extends JevError {
  constructor(spent, budget) {
    super(
      `Jev budget exhausted: spent $${spent.toFixed(4)} of $${budget.toFixed(4)}.`
    );
    this.name = "BudgetExceeded";
    this.spent = spent;
    this.budget = budget;
  }
}

const RETRY_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504]);

// Page content reaches OpenRouter and TypeSafe. Say so once per process, on
// stderr where it lands in the MCP client's server log rather than in a tool
// result the model would have to reason about.
let warnedPrivacy = false;
export function resetPrivacyWarning() {
  warnedPrivacy = false;
}
function warnPrivacyOnce(cfg) {
  if (warnedPrivacy) return;
  warnedPrivacy = true;
  process.stderr.write(
    `[jev] Page content (URL, title, element labels, text excerpt) is being sent to ` +
      `${cfg.provider} for each decision. Restrict this with jev.allowed_domains / ` +
      `jev.blocked_domains in ~/.config/open-claude-in-chrome/config.json.\n`
  );
}

function maxProb(probabilities) {
  if (!probabilities || typeof probabilities !== "object") return null;
  const vals = Object.values(probabilities).filter((v) => typeof v === "number");
  return vals.length ? Math.max(...vals) : null;
}

/**
 * Put a single comparable `confidence` on every answer type.
 *
 * The API returns `confidence` (how peaked the distribution is) for choice and
 * score, but not for noul, where the probability itself carries the certainty:
 * 0.98 and 0.02 are both confident, 0.5 means "can't tell". Mapping noul onto
 * the same 0..1 scale with |p-0.5|*2 lets one min_confidence threshold govern
 * every gate in the loop.
 */
export function normalizeAnswer(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = { type: raw.type, raw };
  if (raw.type === "noul" || typeof raw.noul === "number") {
    out.type = "noul";
    out.noul = raw.noul;
    out.confidence = Math.abs(raw.noul - 0.5) * 2;
    return out;
  }
  if (raw.type === "choice" || typeof raw.choice === "string") {
    out.type = "choice";
    out.choice = raw.choice;
    out.probabilities = raw.probabilities || {};
    out.confidence =
      typeof raw.confidence === "number"
        ? raw.confidence
        : (maxProb(raw.probabilities) ?? 0);
    return out;
  }
  if (raw.type === "score" || typeof raw.score === "number") {
    out.type = "score";
    out.score = raw.score;
    out.legend = raw.legend || {};
    out.probabilities = raw.probabilities || {};
    out.confidence =
      typeof raw.confidence === "number"
        ? raw.confidence
        : (maxProb(raw.probabilities) ?? 0);
    return out;
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A budget-scoped Jev client. One per jev_navigate run, so `spentUsd` is the
 * run's spend and the cap in cfg.budgetUsd bounds a single tool call rather
 * than the lifetime of the server.
 */
export function createClient(cfg, { fetchImpl = globalThis.fetch } = {}) {
  const state = { spentUsd: 0, requests: 0, inputTokens: 0, resolvedModel: null };

  async function post(body, signal) {
    const url = `${cfg.baseUrl.replace(/\/+$/, "")}/decisions`;
    const res = await fetchImpl(url, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
        // Ranking metadata only; harmless and helps OpenRouter attribute usage.
        "HTTP-Referer": "https://github.com/alexandrelam/open-claude-in-chrome",
        "X-Title": "open-claude-in-chrome (jev)"
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new JevError(
        `Jev provider returned ${res.status}: ${text.slice(0, 400)}`,
        { status: res.status, retryable: RETRY_STATUSES.has(res.status) }
      );
    }
    return res.json();
  }

  /**
   * Ask Jev one set of typed questions about one state.
   *
   * @param {string|object|Array} state  What Jev reasons over.
   * @param {Record<string, {type, instructions, criteria}>} questions
   * @returns {{answers, usage, model, ms, raw}}
   */
  async function decide(stateArg, questions, { signal } = {}) {
    warnPrivacyOnce(cfg);
    if (cfg.budgetUsd > 0 && state.spentUsd >= cfg.budgetUsd) {
      throw new BudgetExceeded(state.spentUsd, cfg.budgetUsd);
    }

    const body = { model: cfg.model, state: stateArg, questions };
    const started = Date.now();

    let json;
    try {
      json = await post(body, signal);
    } catch (err) {
      // One retry, jittered. A 4xx that isn't rate limiting is a request we
      // built wrong — retrying it just spends the budget twice.
      if (!(err instanceof JevError) || !err.retryable) throw err;
      await sleep(400 + Math.random() * 400);
      json = await post(body, signal);
    }

    const ms = Date.now() - started;
    const answers = {};
    // Tolerate both {answers:{...}} and a bare answers object at the top level:
    // the endpoint is alpha, and this is the one shape change cheap to absorb.
    const wrapped = Boolean(json && typeof json.answers === "object" && json.answers);
    const rawAnswers = wrapped ? json.answers : json;
    for (const [key, val] of Object.entries(rawAnswers || {})) {
      // Only the bare shape mixes answers with the response's own fields. In
      // the wrapped shape every key is a question, and skipping these there
      // silently dropped a jev_assess question Claude had keyed "model".
      if (!wrapped && (key === "usage" || key === "model" || key === "id")) continue;
      const norm = normalizeAnswer(val);
      if (norm) answers[key] = norm;
    }

    const usage = json?.usage || {};
    const cost = typeof usage.cost === "number" ? usage.cost : 0;
    state.spentUsd += cost;
    state.requests += 1;
    state.inputTokens += Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
    state.resolvedModel = json?.model || cfg.model;

    return { answers, usage: { ...usage, cost }, model: state.resolvedModel, ms, raw: json };
  }

  return {
    decide,
    get totals() {
      return {
        requests: state.requests,
        input_tokens: state.inputTokens,
        cost_usd: Number(state.spentUsd.toFixed(6)),
        budget_usd: cfg.budgetUsd,
        resolved_model: state.resolvedModel
      };
    }
  };
}

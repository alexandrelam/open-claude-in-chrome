// Deterministic narrowing of the action space, before any Jev call.
//
// Why this exists: a Wikipedia article yields 602 usable rows against a
// 255-option provider ceiling, which forced a Jev *scoring* request on every
// single step — doubling the round trips on exactly the pages that are already
// slowest. It also split probability mass across hundreds of options, which
// deflated confidence and escalated runs that were going fine.
//
// Measured composition of those 602 rows:
//
//     320  article links (body prose)
//     139  other links
//     115  citation markers — "[1]", "[2]", ...
//      14  controls (buttons and inputs)
//      11  no accessible name at all
//
// A purely lexical filter is NOT safe here: the goal "open the page's edit
// history" has zero word overlap with the link that does it, "Past revisions of
// this page". So lexical matching only ever ADDS rows here, never removes them.
// What removes rows is noise detection and, as a last resort, document order.

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "this",
  "that", "is", "are", "was", "were", "be", "been", "it", "its", "at", "by",
  "from", "as", "page", "open", "click", "go", "show", "shown", "find", "get"
]);

export function termsFrom(...sources) {
  const out = new Set();
  for (const src of sources) {
    for (const word of String(src ?? "").toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length >= 3 && !STOPWORDS.has(word)) out.add(word);
    }
  }
  return out;
}

/**
 * Rows that carry no decision value on any page.
 *
 * Kept deliberately narrow — every pattern here must be one that cannot be the
 * thing the user asked for. A citation marker is never a navigation target; a
 * row with neither a name nor a destination cannot be described to Jev at all.
 */
export function isNoise(row) {
  const name = (row.name || "").trim();
  if (!name && !row.href && !row.type) return true;
  if (/^\[?\d{1,4}\]?$/.test(name)) return true; // [1], [12], 3
  if (/^\[(edit|citation needed|note \d+)\]$/i.test(name)) return true;
  return false;
}

/** A control is always worth offering: it is what actions are made of. */
export function isControl(row) {
  const role = (row.role || "").toLowerCase();
  return (
    Boolean(row.type) ||
    Array.isArray(row.options) ||
    ["button", "textbox", "searchbox", "combobox", "listbox", "checkbox",
     "radio", "switch", "select", "textarea", "spinbutton", "menuitem",
     "tab"].includes(role)
  );
}

export function lexicalScore(row, terms) {
  if (!terms.size) return 0;
  const hay = `${row.name || ""} ${row.href || ""} ${row.role || ""}`.toLowerCase();
  let hits = 0;
  for (const t of terms) if (hay.includes(t)) hits++;
  return hits;
}

/**
 * Narrow `rows` to at most `limit`, without asking Jev anything.
 *
 * Three tiers, in order of how confident we are that a row matters:
 *   1. controls and anything matching the goal's own words — always kept
 *   2. everything else, in document order, until the budget runs out
 *   3. noise, dropped outright
 *
 * Document order is the tie-breaker rather than a judgement: read_page emits in
 * document order, and actionable page chrome (nav, toolbars, tabs) sits near the
 * top while body prose runs long. Measured: the target was row 21 on the article
 * page and row 4 on the search page. Rows deep in the body are still reachable
 * when they match the goal's words, which is what tier 1 is for.
 *
 * Returns the surviving rows in document order — Jev reads them as a page.
 */
export function prefilter(rows, { goal, successCriteria, values, limit } = {}) {
  const terms = termsFrom(goal, successCriteria, ...Object.keys(values || {}), ...Object.values(values || {}));

  const kept = new Set();
  const signal = [];
  const rest = [];
  let noise = 0;

  for (const row of rows) {
    if (isNoise(row)) {
      noise++;
      continue;
    }
    if (isControl(row) || lexicalScore(row, terms) > 0) signal.push(row);
    else rest.push(row);
  }

  for (const row of signal) {
    if (kept.size >= limit) break;
    kept.add(row);
  }
  for (const row of rest) {
    if (kept.size >= limit) break;
    kept.add(row);
  }

  const out = rows.filter((r) => kept.has(r));
  return {
    rows: out,
    noise,
    overflow: rows.length - noise - out.length,
    signal: signal.length
  };
}

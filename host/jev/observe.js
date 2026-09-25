// Turn a read_page("interactive") dump into typed rows Jev can choose between.
//
// The grammar comes from generateAccessibilityTree() in extension/content.js
// (L207-231). Reproduced here because the parser has to match it exactly:
//
//   <indent><role> "<name, <=100 chars>" [ref_N] [href=".."] [src=".."]
//           [value=".."] [type=".."] [expanded=..] [checked=..] [selected=..]
//           [disabled] [options=[*v="text",  v2="text2"]]
//
// Three properties of that renderer make the naive split-on-spaces parser wrong:
//
//   1. `role` is emitted only `if (role)`, so it can be absent — the line then
//      opens with the indent followed straight by the quote.
//   2. `name` is emitted only `if (name)`, so it can be absent too. `[ref_N]`
//      is the single field guaranteed to be on every line.
//   3. The indent only grows for ancestors that were themselves shown AND
//      visible, so indentation is not DOM depth and must not be read as
//      structure. It is kept only as a grouping hint for shortlisting.

// A name or an href can legitimately contain "[ref_3]" (a URL with a fragment,
// a label quoting one). Pick the ref token that sits outside the quoted name by
// requiring an even number of quotes before it.
function findRefToken(line) {
  const re = /\[(ref_\d+)\]/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    const before = line.slice(0, m.index);
    const quotes = (before.match(/"/g) || []).length;
    if (quotes % 2 === 0) return { ref: m[1], start: m.index, end: m.index + m[0].length };
  }
  return null;
}

function parseOptions(raw) {
  // `${selected ? "*" : " "}${value}="${text}"`, joined with ", ".
  const out = [];
  const re = /([*\s]?)([^=,]*)="((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    out.push({
      value: m[2].trim(),
      label: m[3],
      selected: m[1] === "*"
    });
  }
  return out;
}

function parseAttrs(tail) {
  const attrs = { disabled: false, options: null };

  // options=[...] is appended last, so everything from its marker to the end of
  // the line belongs to it — and its contents hold both commas and quotes, so
  // it must come off before any generic key=value scanning.
  const optIdx = tail.indexOf("options=[");
  let rest = tail;
  if (optIdx !== -1) {
    const inner = tail.slice(optIdx + "options=[".length).replace(/\]\s*$/, "");
    attrs.options = parseOptions(inner);
    rest = tail.slice(0, optIdx);
  }

  if (/(^|\s)disabled(\s|$)/.test(rest)) attrs.disabled = true;

  const quoted = /(\w+)="((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = quoted.exec(rest)) !== null) attrs[m[1]] = m[2];

  const bare = /(\w+)=([^\s"]+)/g;
  while ((m = bare.exec(rest)) !== null) {
    if (attrs[m[1]] === undefined) {
      attrs[m[1]] = m[2] === "true" ? true : m[2] === "false" ? false : m[2];
    }
  }
  return attrs;
}

export function parseLine(line) {
  if (!line || !line.trim()) return null;
  const token = findRefToken(line);
  if (!token) return null;

  const head = line.slice(0, token.start);
  const tail = line.slice(token.end).trim();

  const indent = head.length - head.trimStart().length;
  const headTrimmed = head.trim();

  let role = "";
  let name = "";
  const q = headTrimmed.indexOf('"');
  if (q === -1) {
    role = headTrimmed;
  } else {
    role = headTrimmed.slice(0, q).trim();
    // Greedy to the LAST quote: an accessible name may contain quotes of its
    // own, and the renderer does not escape them.
    const lastQ = headTrimmed.lastIndexOf('"');
    name = lastQ > q ? headTrimmed.slice(q + 1, lastQ) : "";
  }

  const attrs = parseAttrs(tail);
  return {
    ref: token.ref,
    role,
    name,
    indent,
    href: attrs.href || "",
    src: attrs.src || "",
    value: attrs.value ?? "",
    type: attrs.type || "",
    expanded: attrs.expanded,
    checked: attrs.checked,
    selected: attrs.selected,
    disabled: attrs.disabled,
    options: attrs.options
  };
}

export const TRUNCATION_MARKER = "... (truncated)";

/**
 * Parse a whole read_page dump.
 *
 * `truncated` matters beyond diagnostics: anything cut can't be chosen, so a
 * truncated observation is a possible cause of a BLOCKED answer and is recorded
 * as such in the trace.
 */
export function parsePage(text) {
  const truncated = text.includes(TRUNCATION_MARKER);
  const rows = [];
  for (const line of text.split("\n")) {
    if (line.includes(TRUNCATION_MARKER)) continue;
    const row = parseLine(line);
    if (row) rows.push(row);
  }
  return { rows, truncated };
}

/**
 * Narrow the parsed rows to the ones worth offering Jev.
 *
 * Disabled controls are dropped because choosing one wastes a whole step on a
 * no-op the loop would then read as "page didn't change". Duplicates are
 * dropped because identical criteria descriptions would split probability mass
 * between indistinguishable options and depress confidence below the gate.
 */
export function usableRows(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (r.disabled) continue;
    if (!r.role && !r.name && !r.href) continue;
    const key = `${r.role}|${r.name}|${r.href}|${r.type}|${r.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/** The text of an MCP CallToolResult, or "" if it carries none. */
export function resultText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  const block = (result.content || []).find((c) => c.type === "text");
  return block ? block.text : "";
}

// tool-runtime.callTool never throws and never sets isError — every failure
// arrives as a text block starting "Error: " (host/tool-runtime.js L268-270).
// So detecting failure means sniffing the prefix; there is nothing else to test.
export function isToolError(result) {
  return resultText(result).startsWith("Error: ");
}

/** tabs_context_mcp prefixes its prose with a JSON blob. Pull the tab out. */
export function parseTabContext(text, tabId) {
  const brace = text.indexOf("{");
  if (brace === -1) return null;
  const end = text.indexOf("}\n", brace);
  const slice = end === -1 ? text.slice(brace) : text.slice(brace, end + 1);
  try {
    const json = JSON.parse(slice);
    const tab = (json.availableTabs || []).find((t) => t.tabId === tabId);
    return tab ? { url: tab.url, title: tab.title } : null;
  } catch {
    return null;
  }
}

/**
 * One full observation of a tab.
 *
 * The three calls are independent and the runtime multiplexes on a request id
 * (host/tool-runtime.js L176), so they go out together rather than serially —
 * this is most of the per-step browser latency.
 */
export async function observe(callTool, tabId, { excerptChars = 600 } = {}) {
  const [pageRes, textRes, ctxRes] = await Promise.all([
    callTool("read_page", { tabId, filter: "interactive" }),
    callTool("get_page_text", { tabId }),
    callTool("tabs_context_mcp", {})
  ]);

  if (isToolError(pageRes)) {
    return { error: resultText(pageRes) };
  }

  const { rows, truncated } = parsePage(resultText(pageRes));
  const ctx = parseTabContext(resultText(ctxRes), tabId) || { url: "", title: "" };
  const excerpt = isToolError(textRes)
    ? ""
    : resultText(textRes).replace(/\s+/g, " ").trim().slice(0, excerptChars);

  return {
    url: ctx.url,
    title: ctx.title,
    rows: usableRows(rows),
    allRows: rows,
    truncated,
    excerpt
  };
}

/** Identity of a page state, for the "nothing changed" check. */
export function observationSignature(obs) {
  if (!obs) return "";
  return [
    obs.url,
    obs.title,
    obs.rows.length,
    obs.rows.map((r) => `${r.role}:${r.name}:${r.value}`).join("|")
  ].join("~");
}

// The action space, and the deterministic gate around it.
//
// This table is the security boundary. Jev's answer is never a selector, a URL
// or code — it is a key into a set this file built from an observation we just
// took. `navigate`, `javascript_tool`, `file_upload` and `upload_image` are
// absent from the table, so they are unreachable by construction rather than by
// a denylist someone can forget to update.

const CLICK_ROLES = new Set([
  "link", "button", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox",
  "menuitemradio", "option", "switch", "treeitem", "gridcell", "summary"
]);

const TEXT_ROLES = new Set([
  "textbox", "searchbox", "combobox", "spinbutton", "input", "textarea"
]);

const SELECT_ROLES = new Set(["combobox", "listbox", "select", "menu"]);

export const OPERATIONS = {
  CLICK: {
    needsTarget: true,
    description: "Activate an observed link, button or control"
  },
  TYPE_TEXT: {
    needsTarget: true,
    needsValue: true,
    description: "Enter one of the provided values into an editable field"
  },
  SELECT: {
    needsTarget: true,
    needsValue: true,
    description: "Pick an option in a dropdown or list"
  },
  SCROLL_DOWN: { needsTarget: false, description: "Reveal more of the page below" },
  SCROLL_UP: { needsTarget: false, description: "Go back up the page" },
  WAIT: { needsTarget: false, description: "Let the page finish loading or settling" },
  DONE: { needsTarget: false, description: "The goal is already satisfied on this page" },
  BLOCKED: {
    needsTarget: false,
    description: "No offered operation can advance the goal from this page"
  }
};

/** Can this operation act on this row? The gate, applied after Jev answers. */
export function isCompatible(operation, row) {
  if (!OPERATIONS[operation]) return false;
  if (!OPERATIONS[operation].needsTarget) return true;
  if (!row) return false;
  const role = (row.role || "").toLowerCase();
  switch (operation) {
    case "CLICK":
      // An anchor often renders with no role at all; its href is what makes it
      // clickable, so treat that as the evidence rather than demanding a role.
      return CLICK_ROLES.has(role) || Boolean(row.href);
    case "TYPE_TEXT":
      return TEXT_ROLES.has(role) || Boolean(row.type);
    case "SELECT":
      return SELECT_ROLES.has(role) || Array.isArray(row.options);
    default:
      return false;
  }
}

/** Which operations this page can actually support right now. */
export function availableOperations(rows) {
  const ops = new Set(["SCROLL_DOWN", "SCROLL_UP", "WAIT", "DONE", "BLOCKED"]);
  for (const r of rows) {
    if (isCompatible("CLICK", r)) ops.add("CLICK");
    if (isCompatible("TYPE_TEXT", r)) ops.add("TYPE_TEXT");
    if (isCompatible("SELECT", r)) ops.add("SELECT");
  }
  return [...ops];
}

// A page's own words are the more reliable signal here: Jev's `sensitive`
// answer is a judgement about consequences, this is a fact about the label.
// Either one trips the gate, so a miss by one is covered by the other.
const SENSITIVE_WORDS = [
  "delete", "remove", "destroy", "erase", "wipe",
  "pay", "payment", "purchase", "buy", "checkout", "order", "subscribe",
  "send", "publish", "post", "submit", "confirm", "transfer", "withdraw",
  "cancel subscription", "deactivate", "close account", "sign out", "log out"
];

export function looksSensitive(row) {
  if (!row) return false;
  const hay = `${row.name} ${row.value} ${row.type}`.toLowerCase();
  return SENSITIVE_WORDS.some((w) => hay.includes(w));
}

/**
 * Turn a validated (operation, row, value) into the tool calls that perform it.
 * Returns a list because typing into a rich editor needs two.
 */
export function planToolCalls(operation, row, value, tabId) {
  switch (operation) {
    case "CLICK":
      return [["computer", { action: "left_click", ref: row.ref, tabId }]];
    case "SELECT":
      return [["form_input", { ref: row.ref, value, tabId }]];
    case "TYPE_TEXT": {
      // form_input sets the value directly and fires the events a framework
      // listens for — one round trip, no focus dance. It only works on real
      // form controls, which `type` on the row is what tells us; anything else
      // (contenteditable, a styled div) needs select-all-then-type.
      if (row.type) return [["form_input", { ref: row.ref, value, tabId }]];
      return [
        ["computer", { action: "triple_click", ref: row.ref, tabId }],
        ["computer", { action: "type", text: value, tabId }]
      ];
    }
    case "SCROLL_DOWN":
      return [
        ["computer", { action: "scroll", scroll_direction: "down", scroll_amount: 5, tabId }]
      ];
    case "SCROLL_UP":
      return [
        ["computer", { action: "scroll", scroll_direction: "up", scroll_amount: 5, tabId }]
      ];
    case "WAIT":
      return [["computer", { action: "wait", duration: 1, tabId }]];
    default:
      return [];
  }
}

/** A short, stable label for a row — used in traces and in the step log. */
export function rowLabel(row) {
  if (!row) return "";
  const base = [row.role, row.name && `"${row.name}"`].filter(Boolean).join(" ");
  return base || row.href || row.ref;
}

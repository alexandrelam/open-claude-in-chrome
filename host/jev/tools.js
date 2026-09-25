// The two tools server-jev.js adds on top of the ordinary catalog.
//
// Same {name, description, paramShape} shape as host/tool-definitions.js, so
// the registration loop in the server does not have to special-case them.

import { z } from "zod";

export const JEV_TOOLS = [
  {
    name: "jev_navigate",
    description:
      "Delegate a bounded browser subgoal to the Jev decision model, which picks each next action while the extension carries it out in the real profile. Use this instead of a run of read_page/computer calls when the steps are mechanical (click through to a page, filter a list, fill a form whose values you supply). You keep planning: give one subgoal, an observable success condition, and any text to type. Returns the status, the steps taken, and an excerpt of the final page so you can continue without calling read_page. A status of needs_help, needs_value or blocked means it stopped deliberately and is handing control back to you — read `reason` and take the next step yourself with the ordinary tools.",
    paramShape: {
      goal: z
        .string()
        .optional()
        .describe(
          'A single subgoal in natural language, e.g. "open the most recent invoice". Use this or `subgoals`, not both.'
        ),
      subgoals: z
        .array(
          z.object({
            goal: z.string().describe("This leg's objective."),
            success_criteria: z.string().describe("Observable condition that means this leg is finished."),
            values: z.record(z.string()).optional().describe("Text for this leg's fields, as {label: value}.")
          })
        )
        .optional()
        .describe(
          "Several subgoals run in sequence in ONE call — prefer this for any multi-part task, since it collapses what would be several of your turns into one. Each leg starts from the page the previous one left. The run stops at the first leg that does not finish, and `reason` names which, so you can take that step yourself and call again with the rest."
        ),
      tabId: z
        .number()
        .describe("Tab ID to act in. Must be a tab in the MCP group — use tabs_context_mcp first."),
      success_criteria: z
        .string()
        .optional()
        .describe(
          'Observable condition for `goal`, e.g. "an invoice detail page with a total is shown". Checked against the page on every step, so avoid criteria that depend on state not visible on the page. Required with `goal`; use the per-leg field inside `subgoals` instead.'
        ),
      values: z
        .record(z.string())
        .optional()
        .describe(
          'Text you supply for any field that has to be filled, as {label: value}. Jev picks which value belongs in which field but never invents one — if a field needs a value you did not provide, the call returns needs_value.'
        ),
      start_url: z
        .string()
        .optional()
        .describe("Navigate here before the first step. The loop itself can never navigate."),
      max_steps: z.number().optional().describe("Maximum browser actions per subgoal (default 20, hard cap 50)."),
      max_ms: z.number().optional().describe("Wall-clock budget in milliseconds for the whole call, across every subgoal (default 60000)."),
      min_confidence: z
        .number()
        .optional()
        .describe(
          "Minimum decision confidence, 0..1 (default 0.6). Below this the loop hands back with needs_help rather than guessing."
        ),
      allow_sensitive: z
        .boolean()
        .optional()
        .describe(
          "Permit actions that look destructive or irreversible (pay, delete, send, publish, submit). Default false, which stops and asks instead. Only set this when the user has asked for that specific action."
        )
    }
  },
  {
    name: "jev_decide",
    description:
      "Advisory: observe the tab and ask Jev what it would do next, WITHOUT doing it. Returns the proposed operation, the target element, the full probability distribution and whether the action looks sensitive. Use it to sanity-check the loop on a new site, or to see Jev's reasoning shape before committing to jev_navigate.",
    paramShape: {
      goal: z.string().describe("The subgoal to decide against."),
      tabId: z.number().describe("Tab ID to observe. Must be a tab in the MCP group."),
      success_criteria: z.string().describe("The observable condition that would mean the goal is met."),
      values: z.record(z.string()).optional().describe("Candidate values, as {label: value}."),
      allow_sensitive: z
        .boolean()
        .optional()
        .describe("Report a sensitive action as proposed rather than gated. Nothing is executed either way.")
    }
  }
];

export const JEV_TOOL_NAMES = new Set(JEV_TOOLS.map((t) => t.name));

#!/usr/bin/env node

// MCP server variant: the ordinary tool catalog plus a Jev decision layer.
//
// Same process lifecycle as host/mcp-server.js, and the same in-process
// callTool — the navigator loop runs several browser calls per step, so the
// extra stdio hop a child mcp-server.js would add is the one cost worth
// avoiding here.
//
// Degradation follows execute_code in codemode/server-hybrid.js: stdio comes up
// first and the passthrough tools work immediately; the Jev tools are always
// advertised and fail individually with an actionable message when there is no
// API key. A missing key must never stop the browser tools from working.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { init, callTool, shutdown, coerceArgs } from "./tool-runtime.js";
import { TOOLS } from "./tool-definitions.js";
import { watchParent } from "./parent-watch.js";

import { JEV_TOOLS } from "./jev/tools.js";
import { resolveConfig, configError } from "./jev/config.js";
import { createClient } from "./jev/client.js";
import { navigate, decideOnce } from "./jev/navigator.js";

function exitClean(code = 0) {
  try {
    shutdown();
  } catch {}
  process.exit(code);
}

process.on("SIGTERM", () => exitClean());
process.on("SIGINT", () => exitClean());
process.on("SIGHUP", () => exitClean());
process.stdin.on("end", () => exitClean());
process.stdin.resume();

// stdin EOF is the fast path, but it only arrives if nobody else holds a copy
// of the write end. Watching the parent directly is the backstop that does not
// depend on the pipe — without it these processes accumulate indefinitely.
watchParent(() => exitClean());

await init();

const cfg = resolveConfig();
const cfgError = configError(cfg);
if (cfgError) process.stderr.write(`[jev] ${cfgError}\n`);

const server = new McpServer({
  name: "open-claude-in-chrome-jev",
  version: "1.0.0"
});

// Coerce stringified args (tabId, coordinate, etc.) before zod validation
// runs on tool-call requests. Some MCP clients serialize numbers/arrays
// as strings; the extension expects the real types.
{
  const origSetRequestHandler = server.server.setRequestHandler.bind(
    server.server
  );
  server.server.setRequestHandler = function (schema, handler) {
    return origSetRequestHandler(schema, async (request, extra) => {
      if (request?.params?.arguments) coerceArgs(request.params.arguments);
      return handler(request, extra);
    });
  };
}

function errorResult(text) {
  return { content: [{ type: "text", text }], isError: true };
}

// Both Jev tools return JSON. structuredContent carries the machine-readable
// copy for clients that support it; the text block is what Claude actually
// reads, so it has to stand alone.
function jsonResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value
  };
}

async function runJevTool(name, args) {
  if (cfgError) return errorResult(`Jev tools unavailable: ${cfgError}`);
  // A client per call, so the budget in JEV_BUDGET_USD bounds one tool call
  // rather than the lifetime of the server.
  const client = createClient(cfg);
  try {
    const out =
      name === "jev_navigate"
        ? await navigate(callTool, client, cfg, args)
        : await decideOnce(callTool, client, cfg, args);
    return jsonResult(out);
  } catch (err) {
    return errorResult(
      `${name} failed: ${err?.message ?? err}\nSpent so far: $${client.totals.cost_usd}.`
    );
  }
}

for (const t of TOOLS) {
  server.tool(t.name, t.description, t.paramShape, async (args) =>
    callTool(t.name, args)
  );
}

for (const t of JEV_TOOLS) {
  server.tool(t.name, t.description, t.paramShape, async (args) =>
    runJevTool(t.name, args)
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);

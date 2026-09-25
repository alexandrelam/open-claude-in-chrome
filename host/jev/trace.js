// Per-run traces, written to ~/.config/open-claude-in-chrome/jev-runs/<id>.json.
//
// Local only, and deliberately so: a trace holds page labels and the text the
// caller supplied, which is exactly the material the privacy warning is about.
// It never leaves the machine.
//
// Writing is best-effort throughout. A full disk or a read-only home should
// cost you the trace, not the browser action you were in the middle of.

import fs from "node:fs";
import path from "node:path";

export function newRunId() {
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export function createTrace(dir, meta) {
  const runId = newRunId();
  const trace = {
    run_id: runId,
    started_at: new Date().toISOString(),
    ...meta,
    steps: [],
    result: null
  };

  return {
    runId,
    step(entry) {
      trace.steps.push(entry);
    },
    finish(result, usage) {
      trace.result = result;
      trace.usage = usage;
      trace.finished_at = new Date().toISOString();
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, `${runId}.json`),
          JSON.stringify(trace, null, 2)
        );
      } catch (err) {
        process.stderr.write(`[jev] could not write trace: ${err?.message ?? err}\n`);
      }
      return trace;
    },
    get data() {
      return trace;
    }
  };
}

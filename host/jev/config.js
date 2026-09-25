// Resolved configuration for the Jev decision layer.
//
// Three sources, highest first: process.env, the `jev` object in
// ~/.config/open-claude-in-chrome/config.json, then the defaults below. The
// config file is read with the same tolerance as host/endpoint.js — any failure
// yields {}, because a malformed config should degrade the Jev tools, not stop
// the 26 passthrough tools from coming up.
//
// Deliberately NOT wired into the get_config/set_config catalog: that catalog
// is CONFIG_SCHEMA in extension/background.js, and this feature ships without
// touching the extension.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const CONFIG_DIR = path.join(
  os.homedir(),
  ".config",
  "open-claude-in-chrome"
);

export function readConfigFile() {
  try {
    return JSON.parse(
      fs.readFileSync(path.join(CONFIG_DIR, "config.json"), "utf-8")
    );
  } catch {
    return {};
  }
}

const DEFAULTS = {
  provider: "openrouter",
  openrouter_base_url: "https://openrouter.ai/api/alpha",
  typesafe_base_url: "https://api.typesafe.ai/v1",
  // ~typesafe/jev-latest tracks the newest release and can move under us; the
  // resolved id is written into every run trace so a silent bump is visible
  // after the fact. Pin a versioned slug (typesafe/jev-1.13) in production.
  model: "~typesafe/jev-latest",
  max_steps: 20,
  max_ms: 60_000,
  min_confidence: 0.6,
  // Jev's context window is 32k tokens. This is the row count at which
  // shortlisting kicks in; the token estimate is the real gate (see budget.js).
  max_rows: 120,
  budget_usd: 0.5,
  sensitive_threshold: 0.5,
  allowed_domains: null,
  blocked_domains: []
};

// Hard ceiling from the PRD: a caller may lower max_steps, never raise it past
// this. Runaway loops on someone's logged-in banking tab are the failure mode
// that matters, so the cap is not configurable.
export const MAX_STEPS_CEILING = 50;

function num(raw, fallback) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function list(raw, fallback) {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string" && raw.trim())
    return raw.split(",").map((s) => s.trim()).filter(Boolean);
  return fallback;
}

/**
 * Resolve the effective Jev config. `env` and `file` are injectable so the
 * tests can exercise precedence without touching the real environment.
 */
export function resolveConfig(env = process.env, file = readConfigFile()) {
  const j = (file && typeof file.jev === "object" && file.jev) || {};
  const provider = env.JEV_PROVIDER || j.provider || DEFAULTS.provider;

  return {
    provider,
    apiKey:
      provider === "typesafe"
        ? env.TYPESAFE_API_KEY || j.typesafe_api_key || ""
        : env.OPENROUTER_API_KEY || j.openrouter_api_key || "",
    baseUrl:
      provider === "typesafe"
        ? env.TYPESAFE_BASE_URL || j.typesafe_base_url || DEFAULTS.typesafe_base_url
        : env.OPENROUTER_BASE_URL ||
          j.openrouter_base_url ||
          DEFAULTS.openrouter_base_url,
    model: env.JEV_MODEL || j.model || DEFAULTS.model,
    maxSteps: Math.min(
      num(env.JEV_MAX_STEPS, num(j.max_steps, DEFAULTS.max_steps)),
      MAX_STEPS_CEILING
    ),
    maxMs: num(env.JEV_MAX_MS, num(j.max_ms, DEFAULTS.max_ms)),
    minConfidence: num(
      env.JEV_MIN_CONFIDENCE,
      num(j.min_confidence, DEFAULTS.min_confidence)
    ),
    maxRows: num(env.JEV_MAX_ROWS, num(j.max_rows, DEFAULTS.max_rows)),
    budgetUsd: num(env.JEV_BUDGET_USD, num(j.budget_usd, DEFAULTS.budget_usd)),
    sensitiveThreshold: num(
      env.JEV_SENSITIVE_THRESHOLD,
      num(j.sensitive_threshold, DEFAULTS.sensitive_threshold)
    ),
    // null means "no allowlist" — every domain is permitted. An empty ARRAY is
    // a different thing and permits nothing, so don't collapse the two.
    allowedDomains: list(env.JEV_ALLOWED_DOMAINS, j.allowed_domains ?? DEFAULTS.allowed_domains),
    blockedDomains: list(env.JEV_BLOCKED_DOMAINS, j.blocked_domains ?? DEFAULTS.blocked_domains),
    tracesDir: path.join(CONFIG_DIR, "jev-runs")
  };
}

/** Why the Jev tools can't run, or null if they can. */
export function configError(cfg) {
  if (!cfg.apiKey) {
    const key =
      cfg.provider === "typesafe" ? "TYPESAFE_API_KEY" : "OPENROUTER_API_KEY";
    return `${key} is not set. The Jev tools need it; the other tools on this server work without it. Set it in the MCP server's env, or put "jev": { "${key.toLowerCase()}": "..." } in ~/.config/open-claude-in-chrome/config.json.`;
  }
  return null;
}

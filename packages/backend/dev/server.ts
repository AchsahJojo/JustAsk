// Local planner for development and e2e tests. Serves the same POST /plan contract as the
// Convex HTTP action. Uses Claude when ANTHROPIC_API_KEY is set (and JUSTASK_MOCK is not 1),
// otherwise the scripted mock planner. PLANNER_PROVIDER=deepseek uses DeepSeek with DEEPSEEK_API_KEY
// (issue #18, dev and eval only), from the shell or a git-ignored .env.local at the repo root.
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PlanRequest } from "@justask/shared";
import { mockPlan, type MockRule } from "../lib/mockPlanner";
import { pickProvider } from "../lib/providers";
import { QueryRequest } from "@justask/shared";
import { searchQueryFor } from "@justask/core";

const PORT = Number(process.env.PLANNER_PORT ?? 8787);

// Provider settings from .env.local (git-ignored, `.env*` in .gitignore). The shell wins.
const ENV_LOCAL = fileURLToPath(new URL("../../../.env.local", import.meta.url));
if (existsSync(ENV_LOCAL)) {
  for (const line of readFileSync(ENV_LOCAL, "utf8").split(/\r?\n/)) {
    const m = /^\s*(PLANNER_PROVIDER|DEEPSEEK_API_KEY|ANTHROPIC_API_KEY)\s*=\s*"?([^"\s]*)"?\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
/**
 * The scripted mock runs only when asked for (JUSTASK_MOCK=1, as e2e does). Its fallback just picks
 * the element sharing the most words with the request, which looks like real (bad) guidance on real
 * sites, so without a key and without JUSTASK_MOCK the planner refuses instead of guessing.
 */
const mockMode = process.env.JUSTASK_MOCK === "1";
const picked = mockMode ? null : pickProvider(process.env);
const provider = picked?.ok ? picked.provider : null;
if (picked?.ok && picked.warning) console.warn(picked.warning);
const mode = provider ? (provider.name === "anthropic" ? "claude" : provider.name) : mockMode ? "mock" : "no-key";
const scriptPath = process.env.JUSTASK_MOCK_SCRIPT ?? fileURLToPath(new URL("../../../apps/fixtures/mock-script.json", import.meta.url));
const rules: MockRule[] = mockMode ? JSON.parse(readFileSync(scriptPath, "utf8")) : [];

/**
 * Requests received, for e2e assertions (leak test). Mock mode only (what e2e runs), in memory:
 * with Claude, the planner keeps nothing, so real pages never sit behind GET /__received.
 */
const keepReceived = mockMode;
const received: string[] = [];

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (req.method === "GET" && req.url === "/health") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, mode }));
  if (req.method === "GET" && req.url === "/__received" && keepReceived) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(received));
  if (req.method === "POST" && req.url === "/__reset") {
    received.length = 0;
    return res.writeHead(204).end();
  }
  if (req.method === "POST" && req.url === "/event") {
    for await (const _ of req) void _;
    return res.writeHead(204).end();
  }
  if (req.method === "POST" && req.url === "/search-query") {
    let qbody = "";
    for await (const chunk of req) qbody += chunk;
    const q = QueryRequest.safeParse(JSON.parse(qbody || "{}"));
    if (!q.success) return res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "bad request" }));
    if (mode === "no-key") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "planner has no ANTHROPIC_API_KEY" }));
    // The mock stands in with the plain filler-stripping, so e2e stays deterministic.
    const out = provider ? await provider.searchQuery(q.data.request) : { ok: true, query: searchQueryFor(q.data.request) };
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
  }
  if (req.method !== "POST" || req.url !== "/plan") return res.writeHead(404).end();

  let body = "";
  for await (const chunk of req) body += chunk;
  if (keepReceived) received.push(body);
  const parsed = PlanRequest.safeParse(JSON.parse(body || "{}"));
  if (!parsed.success) {
    return res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "bad request", retryable: false }));
  }
  if (mode === "no-key") {
    return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "planner has no ANTHROPIC_API_KEY", retryable: false }));
  }
  const out = provider
    ? await provider.planStep(parsed.data, (l) => console.log("[plan]", JSON.stringify(l)))
    : mockPlan(parsed.data, rules);
  if (!provider && process.env.MOCK_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.MOCK_DELAY_MS)));
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
});

server.listen(PORT, () => {
  console.log(`JustAsk dev planner on http://localhost:${PORT} (${mode})`);
  if (mode === "no-key") console.error("No ANTHROPIC_API_KEY: every /plan request fails. Set the key, or JUSTASK_MOCK=1 for the scripted test planner.");
});

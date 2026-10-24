// Local planner for development and e2e tests. Serves the same POST /plan contract as the
// Convex HTTP action. Uses Claude when ANTHROPIC_API_KEY is set (and JUSTASK_MOCK is not 1),
// otherwise the scripted mock planner.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { PlanRequest } from "@justask/shared";
import { makeClient, planStep } from "../lib/planStep";
import { mockPlan, type MockRule } from "../lib/mockPlanner";

const PORT = Number(process.env.PLANNER_PORT ?? 8787);
const useClaude = !!process.env.ANTHROPIC_API_KEY && process.env.JUSTASK_MOCK !== "1";
const scriptPath = process.env.JUSTASK_MOCK_SCRIPT ?? fileURLToPath(new URL("../../../apps/fixtures/mock-script.json", import.meta.url));
const rules: MockRule[] = useClaude ? [] : JSON.parse(readFileSync(scriptPath, "utf8"));
const client = useClaude ? makeClient(process.env.ANTHROPIC_API_KEY!) : null;

/**
 * Requests received, for e2e assertions (leak test). Mock mode only (what e2e runs), in memory:
 * with Claude, the planner keeps nothing, so real pages never sit behind GET /__received.
 */
const keepReceived = !useClaude;
const received: string[] = [];

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (req.method === "GET" && req.url === "/health") return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, mode: useClaude ? "claude" : "mock" }));
  if (req.method === "GET" && req.url === "/__received" && keepReceived) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(received));
  if (req.method === "POST" && req.url === "/__reset") {
    received.length = 0;
    return res.writeHead(204).end();
  }
  if (req.method === "POST" && req.url === "/event") {
    for await (const _ of req) void _;
    return res.writeHead(204).end();
  }
  if (req.method !== "POST" || req.url !== "/plan") return res.writeHead(404).end();

  let body = "";
  for await (const chunk of req) body += chunk;
  if (keepReceived) received.push(body);
  const parsed = PlanRequest.safeParse(JSON.parse(body || "{}"));
  if (!parsed.success) {
    return res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "bad request", retryable: false }));
  }
  const out = client
    ? await planStep(client, parsed.data, (l) => console.log("[plan]", JSON.stringify(l)))
    : mockPlan(parsed.data, rules);
  if (!client && process.env.MOCK_DELAY_MS) await new Promise((r) => setTimeout(r, Number(process.env.MOCK_DELAY_MS)));
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(out));
});

server.listen(PORT, () => console.log(`JustAsk dev planner on http://localhost:${PORT} (${useClaude ? "Claude " : "mock"})`));

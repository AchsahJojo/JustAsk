import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { runPlan, runQuery } from "./plan";
import { auth } from "./auth";

const http = httpRouter();

// Convex Auth (caregiver sign-in): OpenID config and JWKS routes.
auth.addHttpRoutes(http);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

http.route({
  path: "/plan",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await req.text();
    if (body.length > 200_000) return new Response(JSON.stringify({ ok: false, error: "too large", retryable: false }), { status: 413, headers: cors });
    const out = await runPlan(ctx, body);
    return new Response(JSON.stringify(out), { status: 200, headers: { ...cors, "content-type": "application/json" } });
  }),
});

http.route({
  path: "/plan",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: cors })),
});

http.route({
  path: "/search-query",
  method: "POST",
  handler: httpAction(async (ctx, req) => {
    const body = await req.text();
    if (body.length > 4_000) return new Response(JSON.stringify({ ok: false, error: "too large" }), { status: 413, headers: cors });
    const out = await runQuery(ctx, body);
    return new Response(JSON.stringify(out), { status: 200, headers: { ...cors, "content-type": "application/json" } });
  }),
});

http.route({
  path: "/search-query",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: cors })),
});

export default http;

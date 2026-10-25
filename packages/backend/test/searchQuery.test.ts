import { describe, expect, it, vi } from "vitest";
import Anthropic from "@anthropic-ai/sdk";
import { cleanQuery } from "@justask/shared";
import { searchQuery, QUERY_SYSTEM } from "../lib/searchQuery";

function fakeClient(reply: { stop_reason: string; text?: string } | Error) {
  const create = vi.fn(async (_body: any) => {
    if (reply instanceof Error) throw reply;
    return { stop_reason: reply.stop_reason, content: reply.text ? [{ type: "text", text: reply.text }] : [], usage: { output_tokens: 10 } };
  });
  return { client: { beta: { messages: { create } } } as unknown as Anthropic, create };
}

describe("searchQuery", () => {
  it("sends only the user's words, with the same model, effort and fallbacks as planStep", async () => {
    const { client, create } = fakeClient({ stop_reason: "end_turn", text: '{"query":"pink owala water bottle amazon"}' });
    expect(await searchQuery(client, "I want to buy a pink owala on Amazon")).toEqual({ ok: true, query: "pink owala water bottle amazon" });
    const body = create.mock.calls[0][0];
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.output_config.effort).toBe("low");
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.fallbacks).toBe("default");
    expect(body.betas).toEqual(["server-side-fallback-2026-07-01"]);
    expect(body.system[0].text).toBe(QUERY_SYSTEM);
    expect(body.messages).toEqual([{ role: "user", content: "<request>I want to buy a pink owala on Amazon</request>" }]);
  });

  it.each([
    [{ stop_reason: "refusal" }, "refusal"],
    [{ stop_reason: "max_tokens" }, "max_tokens"],
    [{ stop_reason: "end_turn", text: "not json" }, "unparseable reply"],
    [{ stop_reason: "end_turn", text: '{"query":"  "}' }, "empty query"],
  ])("falls back (ok: false) on %o", async (reply, error) => {
    expect(await searchQuery(fakeClient(reply).client, "weather")).toEqual({ ok: false, error });
  });

  it("an API error is ok: false, never a throw", async () => {
    const r = await searchQuery(fakeClient(new Error("socket hang up")).client, "weather");
    expect(r.ok).toBe(false);
  });
});

describe("cleanQuery", () => {
  it("one line, trimmed, 1–100 characters", () => {
    expect(cleanQuery("  weather\ntoday ")).toBe("weather today");
    expect(cleanQuery("")).toBeNull();
    expect(cleanQuery("x".repeat(101))).toBeNull();
    expect(cleanQuery(42)).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { normalizeHandoff, readToken } from "../src/backend";

describe("normalizeHandoff", () => {
  it("reads _id, id or handoffId", () => {
    expect(normalizeHandoff({ _id: "h1", toKind: "desktop", request: "join zoom", taskId: null, recipe: null })).toEqual({
      id: "h1",
      toKind: "desktop",
      request: "join zoom",
      taskId: null,
      recipe: null,
    });
    expect(normalizeHandoff({ id: "h2", request: "x" })?.id).toBe("h2");
    expect(normalizeHandoff({ handoffId: "h3", request: "x" })?.id).toBe("h3");
  });

  it("drops rows without an id", () => {
    expect(normalizeHandoff({ request: "x" })).toBeNull();
    expect(normalizeHandoff(null)).toBeNull();
  });
});

describe("readToken", () => {
  it("accepts {token, expiresAt} or a bare string", () => {
    expect(readToken({ token: "t1", expiresAt: 1 })).toBe("t1");
    expect(readToken("t2")).toBe("t2");
    expect(readToken(null)).toBeNull();
    expect(readToken({})).toBeNull();
  });
});

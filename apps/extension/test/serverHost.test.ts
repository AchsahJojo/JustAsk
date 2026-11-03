import { describe, expect, it } from "vitest";
import { serverHost } from "../src/lib/serverHost";

describe("serverHost", () => {
  it("shows the host a code has to match, and nothing for a missing address", () => {
    expect(serverHost("https://avid-clam-982.convex.cloud")).toBe("avid-clam-982.convex.cloud");
    expect(serverHost("https://necessary-guineapig-382.convex.site/plan")).toBe("necessary-guineapig-382.convex.site");
    expect(serverHost("")).toBe("");
    expect(serverHost(undefined)).toBe("");
    expect(serverHost("not a url")).toBe("");
  });
});

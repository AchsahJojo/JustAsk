import { describe, expect, it } from "vitest";
import { handoffUrl, isOpenableUrl, linkUrl } from "../src/links";

describe("handoffUrl", () => {
  it("adds #justask=<id> to the start page", () => {
    expect(handoffUrl("https://shop.example.com/refills?x=1", "h123")).toBe("https://shop.example.com/refills?x=1#justask=h123");
  });

  it("replaces an existing hash", () => {
    expect(handoffUrl("https://zoom.example.com/j/1#old", "abc")).toBe("https://zoom.example.com/j/1#justask=abc");
  });

  it("encodes the id", () => {
    expect(handoffUrl("https://a.example/", "a b")).toBe("https://a.example/#justask=a%20b");
  });

  it("throws on a non-URL", () => {
    expect(() => handoffUrl("not a url", "x")).toThrow();
  });
});

describe("linkUrl", () => {
  it("builds the link page with the code in the fragment", () => {
    expect(linkUrl("https://justask.example", "123456")).toBe("https://justask.example/link#justask-link=123456");
  });

  it("strips trailing slashes from the origin", () => {
    expect(linkUrl("https://justask.example//", "654321")).toBe("https://justask.example/link#justask-link=654321");
  });
});

describe("isOpenableUrl", () => {
  it("allows only http(s)", () => {
    expect(isOpenableUrl("https://a.example")).toBe(true);
    expect(isOpenableUrl("http://localhost:5174/")).toBe(true);
    expect(isOpenableUrl("file:///C:/x")).toBe(false);
    expect(isOpenableUrl("javascript:alert(1)")).toBe(false);
    expect(isOpenableUrl(undefined)).toBe(false);
    expect(isOpenableUrl("")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { parseHandoffFragment, parseLinkFragment } from "../src/lib/fragments";

describe("parseHandoffFragment", () => {
  it("reads #justask=<id> on web pages", () => {
    expect(parseHandoffFragment("https://example.com/start#justask=k57abc_DEF-9")).toBe("k57abc_DEF-9");
    expect(parseHandoffFragment("http://localhost:5174/#justask=abc&other=1")).toBe("abc");
    expect(parseHandoffFragment("https://example.com/#x=1&justask=abc")).toBe("abc");
  });

  it("ignores missing, empty and malformed ids", () => {
    expect(parseHandoffFragment("https://example.com/")).toBeNull();
    expect(parseHandoffFragment("https://example.com/#justask=")).toBeNull();
    expect(parseHandoffFragment("https://example.com/#justask=<script>")).toBeNull();
    expect(parseHandoffFragment(`https://example.com/#justask=${"a".repeat(65)}`)).toBeNull();
    expect(parseHandoffFragment("https://example.com/?justask=abc")).toBeNull();
    expect(parseHandoffFragment("https://example.com/#justask-link=123456")).toBeNull();
  });

  it("ignores non-web URLs and junk", () => {
    expect(parseHandoffFragment("chrome://settings/#justask=abc")).toBeNull();
    expect(parseHandoffFragment("file:///C:/x.html#justask=abc")).toBeNull();
    expect(parseHandoffFragment("not a url")).toBeNull();
    expect(parseHandoffFragment(undefined)).toBeNull();
  });
});

describe("parseLinkFragment", () => {
  const ORIGIN = "https://justask.app";

  it("reads a 6-digit code on the link origin", () => {
    expect(parseLinkFragment("https://justask.app/link#justask-link=123456", ORIGIN)).toBe("123456");
    expect(parseLinkFragment("https://justask.app/link#justask-link=123456", "https://justask.app/")).toBe("123456");
  });

  it("rejects other origins, including look-alikes", () => {
    expect(parseLinkFragment("https://evil.example/link#justask-link=123456", ORIGIN)).toBeNull();
    expect(parseLinkFragment("https://justask.app.evil.example/#justask-link=123456", ORIGIN)).toBeNull();
    expect(parseLinkFragment("http://justask.app/#justask-link=123456", ORIGIN)).toBeNull();
    expect(parseLinkFragment("https://justask.app:8443/#justask-link=123456", ORIGIN)).toBeNull();
  });

  it("is off when the origin is unset or invalid", () => {
    expect(parseLinkFragment("https://justask.app/#justask-link=123456", undefined)).toBeNull();
    expect(parseLinkFragment("https://justask.app/#justask-link=123456", "")).toBeNull();
    expect(parseLinkFragment("https://justask.app/#justask-link=123456", "not a url")).toBeNull();
  });

  it("rejects codes that aren't 6 digits", () => {
    expect(parseLinkFragment("https://justask.app/#justask-link=12345", ORIGIN)).toBeNull();
    expect(parseLinkFragment("https://justask.app/#justask-link=1234567", ORIGIN)).toBeNull();
    expect(parseLinkFragment("https://justask.app/#justask-link=", ORIGIN)).toBeNull();
    expect(parseLinkFragment("https://justask.app/", ORIGIN)).toBeNull();
  });
});

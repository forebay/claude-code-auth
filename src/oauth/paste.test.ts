import { describe, expect, it } from "vitest";
import { parsePastedCallback, percentDecode } from "./paste.js";

describe("parsePastedCallback", () => {
  it("reads the code and state from a full redirect url", () => {
    expect(parsePastedCallback("http://localhost:51121/callback?code=abc123&state=xyz789")).toEqual({ code: "abc123", state: "xyz789" });
  });

  it("percent decodes the code and the state", () => {
    expect(parsePastedCallback("http://localhost/callback?code=a%2Fb&state=s%3D1")).toEqual({ code: "a/b", state: "s=1" });
  });

  it("tolerates a url with no state parameter", () => {
    expect(parsePastedCallback("http://localhost/callback?code=abc123")).toEqual({ code: "abc123" });
  });

  it("reads a bare code#state pair, with an empty state as none", () => {
    expect(parsePastedCallback("abc123#xyz789")).toEqual({ code: "abc123", state: "xyz789" });
    expect(parsePastedCallback("abc123#")).toEqual({ code: "abc123" });
  });

  it("takes only the first two segments of a multi hash paste", () => {
    expect(parsePastedCallback("a#b#c")).toEqual({ code: "a", state: "b" });
  });

  it("treats a bare code as a code only", () => {
    expect(parsePastedCallback("just-a-bare-code")).toEqual({ code: "just-a-bare-code" });
  });

  it("trims surrounding whitespace", () => {
    expect(parsePastedCallback("  abc123  \n")).toEqual({ code: "abc123" });
  });

  it("reports nothing pasted as undefined", () => {
    expect(parsePastedCallback("")).toBeUndefined();
    expect(parsePastedCallback("   ")).toBeUndefined();
    expect(parsePastedCallback(undefined)).toBeUndefined();
  });
});

describe("percentDecode", () => {
  it("keeps a plus verbatim rather than reading it as a space", () => {
    expect(percentDecode("a+b")).toBe("a+b");
    expect(percentDecode("a%20b")).toBe("a b");
  });

  it("decodes multi byte utf8 escapes", () => {
    expect(percentDecode("%C3%A4")).toBe("ä");
    expect(percentDecode("%E2%82%AC")).toBe("€");
  });

  it("leaves a stray percent alone", () => {
    expect(percentDecode("100%")).toBe("100%");
    expect(percentDecode("a%zz")).toBe("a%zz");
  });
});

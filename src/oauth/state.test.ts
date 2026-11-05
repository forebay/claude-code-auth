import { describe, expect, it } from "vitest";
import { decodeVerifier, encodeState } from "./state.js";

function stateOf(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

describe("the wire state", () => {
  it("round trips a verifier through url safe base64", () => {
    expect(decodeVerifier(encodeState("verifier-abc"))).toBe("verifier-abc");
  });

  it("carries the verifier as the JSON the old flow sent, unpadded and without url unsafe characters", () => {
    const encoded = encodeState("aa");
    expect(Buffer.from(encoded, "base64url").toString("utf8")).toBe('{"verifier":"aa"}');
    expect(encoded).not.toMatch(/[=+/]/);
  });

  it("keeps a verifier whose encoding needs the url safe alphabet", () => {
    const verifier = Buffer.from([251, 255, 254, 250]).toString("base64url");
    expect(decodeVerifier(encodeState(verifier))).toBe(verifier);
  });

  it("refuses a state carrying no pkce verifier", () => {
    expect(() => decodeVerifier(stateOf({ foo: "bar" }))).toThrow("Missing PKCE verifier in state");
  });

  it("refuses a verifier that is not a string", () => {
    expect(() => decodeVerifier(stateOf({ verifier: 42 }))).toThrow("Missing PKCE verifier in state");
  });

  it("refuses a state that is not an encoded object, an empty one included", () => {
    for (const state of ["", "not base64 json!", stateOf([1]), stateOf("text"), stateOf(null)]) {
      expect(() => decodeVerifier(state)).toThrow("Missing PKCE verifier in state");
    }
  });

  it("accepts a state that arrives padded", () => {
    const padded = Buffer.from('{"verifier":"a"}', "utf8").toString("base64");
    expect(padded.endsWith("=")).toBe(true);
    expect(decodeVerifier(padded)).toBe("a");
  });
});

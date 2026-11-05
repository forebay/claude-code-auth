import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorizationUrl } from "./authorize.js";
import { decodeVerifier } from "./state.js";

const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const entropy = () => Buffer.alloc(64, 9);

describe("authorizationUrl", () => {
  const url = new URL(authorizationUrl({ authorizeUrl: AUTHORIZE_URL, clientId: CLIENT_ID, entropy }));

  it("points at the configured authorize endpoint", () => {
    expect(`${url.origin}${url.pathname}`).toBe(AUTHORIZE_URL);
  });

  it("carries the parameters of the Claude Code flow, in that order", () => {
    expect([...url.searchParams.keys()]).toEqual(["code", "client_id", "response_type", "redirect_uri", "scope", "code_challenge", "code_challenge_method", "state"]);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      code: "true",
      client_id: CLIENT_ID,
      response_type: "code",
      redirect_uri: "https://platform.claude.com/oauth/code/callback",
      scope: "org:create_api_key user:profile user:inference",
      code_challenge_method: "S256",
    });
  });

  it("packs the verifier into the state, so the exchange can run in another process", () => {
    const verifier = decodeVerifier(url.searchParams.get("state") as string);
    expect(verifier).toBe(entropy().toString("base64url"));
    expect(url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("uses the client id it is given", () => {
    const other = new URL(authorizationUrl({ authorizeUrl: AUTHORIZE_URL, clientId: "another-client", entropy }));
    expect(other.searchParams.get("client_id")).toBe("another-client");
  });
});

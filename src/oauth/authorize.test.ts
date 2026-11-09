import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorizationRequest } from "./authorize.js";

const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const entropy = () => Buffer.alloc(64, 9);

describe("authorizationUrl", () => {
  const { url: issued, pending } = authorizationRequest({ authorizeUrl: AUTHORIZE_URL, clientId: CLIENT_ID, entropy });
  const url = new URL(issued);

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

  it("hands back the state it issued and the verifier the challenge was made from", () => {
    expect(url.searchParams.get("state")).toBe(pending.state);
    expect(pending.verifier).toBe(entropy().toString("base64url"));
    expect(url.searchParams.get("code_challenge")).toBe(createHash("sha256").update(pending.verifier).digest("base64url"));
  });

  it("draws a state of its own that does not carry the verifier", () => {
    const random = authorizationRequest({ authorizeUrl: AUTHORIZE_URL, clientId: CLIENT_ID });
    expect(random.pending.state).toHaveLength(43);
    expect(random.url).not.toContain(random.pending.verifier);
  });

  it("uses the client id it is given", () => {
    const other = new URL(authorizationRequest({ authorizeUrl: AUTHORIZE_URL, clientId: "another-client", entropy }).url);
    expect(other.searchParams.get("client_id")).toBe("another-client");
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startOauthServer } from "../../test/fixtures/oauth-server.js";
import type { OauthServer } from "../../test/fixtures/oauth-server.js";
import { exchangeCode } from "./exchange.js";
import { encodeState } from "./state.js";

const NOW = 1_000;
const STATE = encodeState("the-verifier");

let server: OauthServer;

beforeEach(async () => {
  server = await startOauthServer();
});

afterEach(async () => {
  await server.close();
});

const exchange = (overrides: Partial<Parameters<typeof exchangeCode>[0]> = {}) =>
  exchangeCode({ tokenUrl: `${server.url}/v1/oauth/token`, clientId: "client-123", code: "the-code", state: STATE, now: NOW, ...overrides });

describe("exchangeCode", () => {
  it("sends the authorization code grant as JSON, with the verifier from the state and the state itself", async () => {
    await exchange();
    const [request] = server.requestsTo("/v1/oauth/token");
    expect(request?.method).toBe("POST");
    expect(request?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(request?.body ?? "")).toEqual({
      grant_type: "authorization_code",
      client_id: "client-123",
      code: "the-code",
      redirect_uri: "https://platform.claude.com/oauth/code/callback",
      code_verifier: "the-verifier",
      state: STATE,
    });
  });

  it("answers the tokens, an expiry from expires_in and the email as the label", async () => {
    expect(await exchange()).toEqual({
      ok: true,
      tokens: { access: "access-from-grant", refresh: "refresh-from-grant", expires: NOW + 3600 * 1000 },
      label: "me@example.com",
    });
  });

  it("labels by the account email, else the organisation, else nothing", async () => {
    server.tokenResponder = () => ({ status: 200, body: { refresh_token: "r", account: { email: "plain@example.com" }, organization: { name: "Org" } } });
    expect(await exchange()).toMatchObject({ ok: true, label: "plain@example.com" });
    server.tokenResponder = () => ({ status: 200, body: { refresh_token: "r", organization: { name: "Org" } } });
    expect(await exchange()).toMatchObject({ ok: true, label: "Org" });
    server.tokenResponder = () => ({ status: 200, body: { refresh_token: "r" } });
    expect(await exchange()).toEqual({ ok: true, tokens: { refresh: "r", expires: NOW + 3600 * 1000 } });
  });

  it("uses a positive expires_in, and one hour when it is absent or not positive", async () => {
    server.tokenResponder = () => ({ status: 200, body: { refresh_token: "r", expires_in: 60 } });
    expect(await exchange()).toMatchObject({ tokens: { expires: NOW + 60_000 } });
    for (const expiresIn of [0, -5, "soon"]) {
      server.tokenResponder = () => ({ status: 200, body: { refresh_token: "r", expires_in: expiresIn } });
      expect(await exchange()).toMatchObject({ tokens: { expires: NOW + 3600 * 1000 } });
    }
  });

  it("fails, naming the status, when the endpoint refuses", async () => {
    server.tokenResponder = () => ({ status: 400, body: { error: "invalid_grant" } });
    expect(await exchange()).toEqual({ ok: false, error: "the token endpoint answered 400 (invalid_grant)" });
  });

  it("fails on a success body that is not JSON", async () => {
    server.tokenResponder = () => ({ status: 200, rawBody: "not json at all" });
    expect(await exchange()).toEqual({ ok: false, error: "the token endpoint answered a body that is not JSON" });
  });

  it("fails without a refresh token in the response", async () => {
    server.tokenResponder = () => ({ status: 200, body: { access_token: "at-only" } });
    expect(await exchange()).toEqual({ ok: false, error: "missing refresh token in response" });
  });

  it("refuses a state without a verifier before reaching the endpoint", async () => {
    expect(await exchange({ state: Buffer.from("{}").toString("base64url") })).toEqual({ ok: false, error: "Missing PKCE verifier in state" });
    expect(server.requestsTo("/v1/oauth/token")).toHaveLength(0);
  });

  it("fails when the token endpoint does not answer in time", async () => {
    server.tokenResponder = () => ({ status: 200, body: {}, delayMilliseconds: 500 });
    expect(await exchange({ signal: AbortSignal.timeout(50) })).toEqual({ ok: false, error: "the token endpoint did not answer in time" });
  });

  it("carries only the error code of a refusal, never the rest of its body", async () => {
    server.tokenResponder = () => ({ status: 400, body: { error: "invalid_request", error_description: "the-code was reused" } });
    expect(await exchange()).toEqual({ ok: false, error: "the token endpoint answered 400 (invalid_request)" });
  });

  it("fails when the token endpoint does not answer in time", async () => {
    server.tokenResponder = () => ({ status: 200, body: {}, delayMilliseconds: 500 });
    expect(await exchange({ signal: AbortSignal.timeout(50) })).toEqual({ ok: false, error: "the token endpoint did not answer in time" });
  });

  it("carries only the error code of a refusal, never the rest of its body", async () => {
    server.tokenResponder = () => ({ status: 400, body: { error: "invalid_request", error_description: "the-code was reused" } });
    expect(await exchange()).toEqual({ ok: false, error: "the token endpoint answered 400 (invalid_request)" });
  });

  it("fails, without throwing, when the endpoint cannot be reached", async () => {
    const unreachable = server.url;
    await server.close();
    expect(await exchange({ tokenUrl: `${unreachable}/v1/oauth/token` })).toEqual({ ok: false, error: "the token endpoint could not be reached" });
    server = await startOauthServer();
  });

  it("never puts the code, the verifier or a token in a failure reason", async () => {
    server.tokenResponder = () => ({ status: 500, body: { echo: "the-code the-verifier" } });
    const outcome = await exchange();
    expect(JSON.stringify(outcome)).not.toMatch(/the-code|the-verifier|access-from-grant/);
  });

  it("rejects when the caller aborts, rather than answering a failure", async () => {
    server.tokenResponder = () => ({ status: 200, body: {}, delayMilliseconds: 500 });
    const aborter = new AbortController();
    const running = exchange({ signal: aborter.signal });
    aborter.abort(new Error("cancelled"));
    await expect(running).rejects.toThrow();
  });
});

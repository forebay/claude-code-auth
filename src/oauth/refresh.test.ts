import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startOauthServer } from "../../test/fixtures/oauth-server.js";
import type { OauthServer } from "../../test/fixtures/oauth-server.js";
import { refreshTokens } from "./refresh.js";

const NOW = 5_000;

let server: OauthServer;

beforeEach(async () => {
  server = await startOauthServer();
});

afterEach(async () => {
  await server.close();
});

const refresh = (overrides: Partial<Parameters<typeof refreshTokens>[0]> = {}) =>
  refreshTokens({ tokenUrl: `${server.url}/v1/oauth/token`, clientId: "client-123", refreshToken: "old-refresh", now: NOW, ...overrides });

describe("refreshTokens", () => {
  it("posts the form encoded refresh grant", async () => {
    await refresh();
    const [request] = server.requestsTo("/v1/oauth/token");
    expect(request?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(request?.body);
    expect(Object.fromEntries(form)).toEqual({ grant_type: "refresh_token", refresh_token: "old-refresh", client_id: "client-123" });
  });

  it("answers the new access token with an expiry from expires_in", async () => {
    expect(await refresh()).toEqual({ ok: true, tokens: { access: "access-from-refresh", refresh: "old-refresh", expires: NOW + 3600 * 1000 } });
  });

  it("keeps the existing refresh token when the endpoint returns none, and takes a rotated one", async () => {
    server.tokenResponder = () => ({ status: 200, body: { access_token: "a", refresh_token: "rotated", expires_in: 1800 } });
    expect(await refresh()).toEqual({ ok: true, tokens: { access: "a", refresh: "rotated", expires: NOW + 1_800_000 } });
  });

  it("defaults to a one hour expiry when the endpoint reports no expires_in", async () => {
    server.tokenResponder = () => ({ status: 200, body: { access_token: "a" } });
    expect(await refresh()).toMatchObject({ tokens: { expires: NOW + 3600 * 1000 } });
  });

  it("reports an invalid_grant refusal as revoked, which is what disables the account", async () => {
    server.tokenResponder = () => ({ status: 400, body: { error: "invalid_grant", error_description: "Token has been revoked." } });
    expect(await refresh()).toEqual({ ok: false, revoked: true, message: "the token endpoint answered 400 (invalid_grant)" });
  });

  it("reports any other refusal without revoking", async () => {
    server.tokenResponder = () => ({ status: 401, body: { error: "invalid_client" } });
    expect(await refresh()).toEqual({ ok: false, revoked: false, message: "the token endpoint answered 401 (invalid_client)" });
  });

  it("does not revoke on a refusal whose body is not JSON", async () => {
    server.tokenResponder = () => ({ status: 502, rawBody: "<html>bad gateway</html>" });
    expect(await refresh()).toMatchObject({ ok: false, revoked: false });
  });

  it("fails a success that carries no access token", async () => {
    server.tokenResponder = () => ({ status: 200, body: { expires_in: 60 } });
    expect(await refresh()).toMatchObject({ ok: false, revoked: false });
  });

  it("reports an unreachable endpoint as a failure that is not a revocation", async () => {
    const unreachable = server.url;
    await server.close();
    expect(await refresh({ tokenUrl: `${unreachable}/v1/oauth/token` })).toEqual({ ok: false, revoked: false, message: "the token endpoint could not be reached" });
    server = await startOauthServer();
  });
});

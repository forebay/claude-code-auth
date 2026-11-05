import { describe, expect, it } from "vitest";
import { NEVER_ABORTED, NOW, seedAccount, useWorld } from "../../test/world.js";
import { createTokenAccess } from "./access.js";

const world = useWorld();
const HOUR = 3_600_000;

function storedAccount(id: string) {
  return world().library.accounts.list({ store: world().library.store }).accounts?.find((account) => account.id === id);
}

describe("ensureAccess", () => {
  it("answers the stored access token while it is valid, without reaching the endpoint", async () => {
    await seedAccount(world(), "a", NOW + HOUR);
    expect(await createTokenAccess(world().dependencies).ensureAccess("a", NOW, NEVER_ABORTED)).toEqual({ access: "stored-access-a" });
    expect(world().server.requests).toHaveLength(0);
  });

  it("refreshes on expiry, keeping the new tokens in secrets and only the expiry in the store", async () => {
    await seedAccount(world(), "a", NOW - 1);
    const answer = await createTokenAccess(world().dependencies).ensureAccess("a", NOW, NEVER_ABORTED);
    expect(answer).toEqual({ access: "access-from-refresh" });
    expect(world().secrets.entries.get("account.a.access")).toBe("access-from-refresh");
    expect(world().secrets.entries.get("account.a.refresh")).toBe("stored-refresh-a");
    expect(storedAccount("a")?.expires).toBe(NOW + HOUR);
    expect(new URLSearchParams(world().server.requestsTo("/v1/oauth/token")[0]?.body).get("refresh_token")).toBe("stored-refresh-a");
  });

  it("refreshes a token that expires within the skew", async () => {
    await seedAccount(world(), "a", NOW + 30_000);
    expect(await createTokenAccess(world().dependencies).ensureAccess("a", NOW, NEVER_ABORTED)).toEqual({ access: "access-from-refresh" });
  });

  it("refreshes when the access secret is gone though the expiry is still ahead", async () => {
    await seedAccount(world(), "a", NOW + HOUR);
    world().secrets.entries.delete("account.a.access");
    expect(await createTokenAccess(world().dependencies).ensureAccess("a", NOW, NEVER_ABORTED)).toEqual({ access: "access-from-refresh" });
  });

  it("stores a rotated refresh token", async () => {
    await seedAccount(world(), "a", NOW - 1);
    world().server.tokenResponder = () => ({ status: 200, body: { access_token: "n", refresh_token: "rotated" } });
    await createTokenAccess(world().dependencies).ensureAccess("a", NOW, NEVER_ABORTED);
    expect(world().secrets.entries.get("account.a.refresh")).toBe("rotated");
  });

  it("disables the account on invalid_grant with the reason re-login required, and answers none", async () => {
    await seedAccount(world(), "a", NOW - 1);
    world().server.tokenResponder = () => ({ status: 400, body: { error: "invalid_grant" } });
    const answer = await createTokenAccess(world().dependencies).ensureAccess("a", NOW, NEVER_ABORTED);
    expect(answer).toEqual({ none: true, reason: "re-login required" });
    expect(storedAccount("a")).toMatchObject({ enabled: false, disabledReason: "re-login required" });
  });

  it("moves on: a disabled account is no longer acquired and the next one is", async () => {
    await seedAccount(world(), "a", NOW - 1);
    await seedAccount(world(), "b", NOW + HOUR);
    world().server.tokenResponder = () => ({ status: 400, body: { error: "invalid_grant" } });
    const access = createTokenAccess(world().dependencies);
    const { accounts } = world().library;
    const first = accounts.acquire({ store: world().library.store, strategy: "sticky", now: NOW });
    expect(first.id).toBe("a");
    expect(await access.ensureAccess("a", NOW, NEVER_ABORTED)).toMatchObject({ none: true });
    const next = accounts.acquire({ store: world().library.store, strategy: "sticky", now: NOW });
    expect(next.id).toBe("b");
    expect(await access.ensureAccess("b", NOW, NEVER_ABORTED)).toEqual({ access: "stored-access-b" });
    expect(world().server.requestsTo("/v1/oauth/token")).toHaveLength(1);
  });

  it("reports nothing against the account on a refusal that is not a revocation", async () => {
    await seedAccount(world(), "a", NOW - 1);
    world().server.tokenResponder = () => ({ status: 503, body: {} });
    const answer = await createTokenAccess(world().dependencies).ensureAccess("a", NOW, NEVER_ABORTED);
    expect(answer).toEqual({ none: true, reason: "the token endpoint answered 503" });
    const account = storedAccount("a");
    expect(account?.enabled).toBe(true);
    expect(account?.coolingDownUntil).toBeUndefined();
  });

  it("disables an account whose refresh token is missing", async () => {
    await seedAccount(world(), "a", NOW - 1);
    world().secrets.entries.delete("account.a.refresh");
    expect(await createTokenAccess(world().dependencies).ensureAccess("a", NOW, NEVER_ABORTED)).toEqual({ none: true, reason: "re-login required" });
    expect(storedAccount("a")?.enabled).toBe(false);
    expect(world().server.requests).toHaveLength(0);
  });

  it("answers none for an unknown account and for a disabled one, saying why", async () => {
    const access = createTokenAccess(world().dependencies);
    expect(await access.ensureAccess("ghost", NOW, NEVER_ABORTED)).toEqual({ none: true, reason: "no account ghost" });
    await seedAccount(world(), "a", NOW + HOUR);
    world().library.accounts.upsert({ store: world().library.store, account: { id: "a", enabled: false, disabledReason: "quota" } });
    expect(await access.ensureAccess("a", NOW, NEVER_ABORTED)).toEqual({ none: true, reason: "quota" });
  });

  it("makes concurrent refreshes of one account one request, so a rotated token is not spent twice", async () => {
    await seedAccount(world(), "a", NOW - 1);
    world().server.tokenResponder = () => ({ status: 200, body: { access_token: "once", refresh_token: "rotated" }, delayMilliseconds: 50 });
    const access = createTokenAccess(world().dependencies);
    const answers = await Promise.all([access.ensureAccess("a", NOW, NEVER_ABORTED), access.ensureAccess("a", NOW, NEVER_ABORTED)]);
    expect(answers).toEqual([{ access: "once" }, { access: "once" }]);
    expect(world().server.requestsTo("/v1/oauth/token")).toHaveLength(1);
  });

  it("rejects an aborted call and reports nothing against the account", async () => {
    await seedAccount(world(), "a", NOW - 1);
    const aborter = new AbortController();
    aborter.abort(new Error("client went away"));
    await expect(createTokenAccess(world().dependencies).ensureAccess("a", NOW, aborter.signal)).rejects.toThrow("client went away");
    expect(storedAccount("a")).toMatchObject({ enabled: true });
    expect(storedAccount("a")?.coolingDownUntil).toBeUndefined();
    expect(world().server.requests).toHaveLength(0);
  });

  it("still answers when reporting fails, logging it", async () => {
    await seedAccount(world(), "a", NOW - 1);
    world().server.tokenResponder = () => ({ status: 400, body: { error: "invalid_grant" } });
    const failing = { ...world().dependencies, accounts: () => ({ ...world().library.accounts, report: () => { throw new Error("store locked"); } }) };
    expect(await createTokenAccess(failing).ensureAccess("a", NOW, NEVER_ABORTED)).toMatchObject({ none: true });
    expect(world().reports.join()).toMatch(/store locked/);
  });
});

describe("ensureAccess under failure", () => {
  it("answers none and reports nothing when the token endpoint does not answer in time", async () => {
    await seedAccount(world(), "a", NOW - 1);
    world().server.tokenResponder = () => ({ status: 200, body: {}, delayMilliseconds: 500 });
    const access = createTokenAccess({ ...world().dependencies, refreshTimeoutMilliseconds: 50 });
    expect(await access.ensureAccess("a", NOW, NEVER_ABORTED)).toEqual({ none: true, reason: "the token endpoint did not answer in time" });
    expect(storedAccount("a")).toMatchObject({ enabled: true });
    expect(storedAccount("a")?.coolingDownUntil).toBeUndefined();
  });

  it("writes a rotated refresh token before the access token, so a failure between them loses no spent token", async () => {
    await seedAccount(world(), "a", NOW - 1);
    world().server.tokenResponder = () => ({ status: 200, body: { access_token: "n", refresh_token: "rotated" } });
    const secrets = world().secrets;
    const failing = {
      ...world().dependencies,
      secrets: {
        ...secrets,
        set: async (name: string, value: string) => {
          if (name.endsWith(".access")) throw new Error("keychain locked");
          await secrets.set(name, value);
        },
      },
    };
    await expect(createTokenAccess(failing).ensureAccess("a", NOW, NEVER_ABORTED)).rejects.toThrow("keychain locked");
    expect(secrets.entries.get("account.a.refresh")).toBe("rotated");
  });

  it("leaves a rate limit cooldown untouched and the account unused after a good refresh", async () => {
    await seedAccount(world(), "a", NOW - 1);
    world().library.accounts.report({ store: world().library.store, id: "a", outcome: "rate-limited", now: NOW, resetAt: NOW + 600_000 });
    const before = storedAccount("a");
    expect(before?.coolingDownUntil).toBe(NOW + 600_000);
    await createTokenAccess(world().dependencies).ensureAccess("a", NOW, NEVER_ABORTED);
    expect(storedAccount("a")?.coolingDownUntil).toBe(NOW + 600_000);
    expect(storedAccount("a")?.lastUsed).toBe(before?.lastUsed);
  });

  it("logs a refused expiry upsert with its fix and still answers the token it got", async () => {
    await seedAccount(world(), "a", NOW - 1);
    const refusing = { ...world().dependencies, accounts: () => ({ ...world().library.accounts, upsert: () => ({ refused: "the store is read only", fix: "make it writable" }) }) };
    expect(await createTokenAccess(refusing).ensureAccess("a", NOW, NEVER_ABORTED)).toEqual({ access: "access-from-refresh" });
    expect(world().reports.join()).toMatch(/the store is read only.*make it writable/);
  });

  it("logs a refused report with its fix", async () => {
    await seedAccount(world(), "a", NOW - 1);
    world().server.tokenResponder = () => ({ status: 400, body: { error: "invalid_grant" } });
    const refusing = { ...world().dependencies, accounts: () => ({ ...world().library.accounts, report: () => ({ refused: "the store is read only", fix: "make it writable" }) }) };
    expect(await createTokenAccess(refusing).ensureAccess("a", NOW, NEVER_ABORTED)).toMatchObject({ none: true });
    expect(world().reports.join()).toMatch(/the store is read only.*make it writable/);
  });
});

describe("refreshNow", () => {
  it("refreshes a token that is still valid", async () => {
    await seedAccount(world(), "a", NOW + HOUR);
    expect(await createTokenAccess(world().dependencies).refreshNow("a", NOW, NEVER_ABORTED)).toEqual({ access: "access-from-refresh" });
  });
});

import { describe, expect, it } from "vitest";
import { NOW, seedAccount, useWorld } from "../../test/world.js";
import { createTokenAccess } from "./access.js";
import { listAccountsAction, refreshAction, removeAction, verifyAction } from "./actions.js";

const world = useWorld();
const HOUR = 3_600_000;

function stored(id: string) {
  return world().library.accounts.list({ store: world().library.store }).accounts?.find((account) => account.id === id);
}

const verify = () => verifyAction(world().dependencies, createTokenAccess(world().dependencies));

describe("the accounts action", () => {
  it("lists each account with whether it is usable and never a token", async () => {
    await seedAccount(world(), "a", NOW + HOUR);
    world().library.accounts.upsert({ store: world().library.store, account: { id: "b", enabled: false, disabledReason: "re-login required" } });
    const listed = listAccountsAction(world().dependencies)();
    expect(listed.accounts).toEqual([
      { id: "a", label: "a", enabled: true, expires: NOW + HOUR },
      { id: "b", enabled: false, disabledReason: "re-login required" },
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/stored-/);
  });

  it("lists nothing when no account was added", () => {
    expect(listAccountsAction(world().dependencies)()).toEqual({ accounts: [] });
  });
});

describe("the verify action", () => {
  it.each([200, 400, 429])("reports a %i as verified", async (status) => {
    await seedAccount(world(), "a", NOW + HOUR);
    world().server.messagesResponder = () => ({ status, body: {} });
    expect(await verify()({ item: "a" })).toEqual({ results: [{ id: "a", status: "verified" }] });
  });

  it("sends the one token message with the oauth headers and the access token", async () => {
    await seedAccount(world(), "a", NOW + HOUR);
    await verify()({ item: "a" });
    const [request] = world().server.requestsTo("/v1/messages");
    expect(request?.headers).toMatchObject({ authorization: "Bearer stored-access-a", "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" });
    expect(request?.headers["x-api-key"]).toBeUndefined();
    expect(JSON.parse(request?.body ?? "")).toMatchObject({ max_tokens: 1, system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." }] });
  });

  it("reports a 401 as expired and makes the next use refresh the token", async () => {
    await seedAccount(world(), "a", NOW + HOUR);
    world().server.messagesResponder = () => ({ status: 401, body: {} });
    const answer = await verify()({ item: "a" });
    expect(answer.results[0]).toMatchObject({ id: "a", status: "expired" });
    expect(stored("a")).toMatchObject({ enabled: true, expires: NOW });
    expect(await createTokenAccess(world().dependencies).ensureAccess("a", NOW, new AbortController().signal)).toEqual({ access: "access-from-refresh" });
  });

  it("reports a 403 as disabled and disables the account", async () => {
    await seedAccount(world(), "a", NOW + HOUR);
    world().server.messagesResponder = () => ({ status: 403, body: {} });
    expect((await verify()({ item: "a" })).results[0]).toMatchObject({ id: "a", status: "disabled" });
    expect(stored("a")).toMatchObject({ enabled: false, disabledReason: "re-login required (token lacks inference scope)" });
  });

  it("reports any other status as failed with the status", async () => {
    await seedAccount(world(), "a", NOW + HOUR);
    world().server.messagesResponder = () => ({ status: 500, body: {} });
    expect((await verify()({ item: "a" })).results[0]).toEqual({ id: "a", status: "failed", detail: "the upstream answered 500" });
  });

  it("reports an account with no usable token as failed, saying why", async () => {
    await seedAccount(world(), "a", NOW - 1);
    world().server.tokenResponder = () => ({ status: 400, body: { error: "invalid_grant" } });
    expect((await verify()({ item: "a" })).results[0]).toEqual({ id: "a", status: "failed", detail: "re-login required" });
  });

  it("verifies every enabled account when run without a row", async () => {
    await seedAccount(world(), "a", NOW + HOUR);
    await seedAccount(world(), "b", NOW + HOUR);
    world().library.accounts.upsert({ store: world().library.store, account: { id: "c", enabled: false } });
    expect((await verify()({})).results.map((result) => result.id)).toEqual(["a", "b"]);
  });
});

describe("one bad account", () => {
  async function twoAccountsWithABrokenFirst() {
    await seedAccount(world(), "a", NOW + HOUR);
    await seedAccount(world(), "b", NOW + HOUR);
    const secrets = world().secrets;
    const broken = {
      ...secrets,
      get: async (name: string) => {
        if (name.includes(".a.")) throw new Error("keychain locked");
        return secrets.get(name);
      },
    };
    return { ...world().dependencies, secrets: broken };
  }

  it("does not lose the other accounts' verify results", async () => {
    const dependencies = await twoAccountsWithABrokenFirst();
    const answer = await verifyAction(dependencies, createTokenAccess(dependencies))({});
    expect(answer.results).toEqual([{ id: "a", status: "failed", detail: "keychain locked" }, { id: "b", status: "verified" }]);
  });

  it("does not lose the other accounts' refresh results", async () => {
    const dependencies = await twoAccountsWithABrokenFirst();
    const answer = await refreshAction(dependencies, createTokenAccess(dependencies))({});
    expect(answer.results).toEqual([{ id: "a", refreshed: false, reason: "keychain locked" }, { id: "b", refreshed: true }]);
  });
});

describe("a refusing accounts service", () => {
  const refusal = { refused: "the store is read only", fix: "make it writable" };

  it("fails remove with the cause and fix, keeping the tokens", async () => {
    await seedAccount(world(), "a", NOW + HOUR);
    const refusing = { ...world().dependencies, accounts: () => ({ ...world().library.accounts, remove: () => refusal }) };
    await expect(removeAction(refusing)({ item: "a" })).rejects.toThrow(/the store is read only.*make it writable/);
    expect(world().secrets.entries.size).toBe(2);
  });

  it("logs a refused disable after a 403 with its fix", async () => {
    await seedAccount(world(), "a", NOW + HOUR);
    world().server.messagesResponder = () => ({ status: 403, body: {} });
    const refusing = { ...world().dependencies, accounts: () => ({ ...world().library.accounts, report: () => refusal }) };
    await verifyAction(refusing, createTokenAccess(refusing))({ item: "a" });
    expect(world().reports.join()).toMatch(/the store is read only.*make it writable/);
  });

  it("fails the accounts action with the cause and fix when the list is refused", () => {
    const refusing = { ...world().dependencies, accounts: () => ({ ...world().library.accounts, list: () => refusal }) };
    expect(() => listAccountsAction(refusing)()).toThrow(/the store is read only.*make it writable/);
  });
});

describe("the refresh action", () => {
  it("refreshes the row's account", async () => {
    await seedAccount(world(), "a", NOW + HOUR);
    const action = refreshAction(world().dependencies, createTokenAccess(world().dependencies));
    expect(await action({ item: "a" })).toEqual({ results: [{ id: "a", refreshed: true }] });
    expect(world().secrets.entries.get("account.a.access")).toBe("access-from-refresh");
  });

  it("says why an account could not be refreshed", async () => {
    await seedAccount(world(), "a", NOW + HOUR);
    world().server.tokenResponder = () => ({ status: 400, body: { error: "invalid_grant" } });
    const action = refreshAction(world().dependencies, createTokenAccess(world().dependencies));
    expect(await action({ item: "a" })).toEqual({ results: [{ id: "a", refreshed: false, reason: "re-login required" }] });
  });
});

describe("the remove action", () => {
  it("forgets the account and deletes its tokens", async () => {
    await seedAccount(world(), "a", NOW + HOUR);
    expect(await removeAction(world().dependencies)({ item: "a" })).toEqual({ id: "a", removed: true });
    expect(stored("a")).toBeUndefined();
    expect(world().secrets.entries.size).toBe(0);
  });

  it("refuses to run without an account", async () => {
    await expect(removeAction(world().dependencies)({})).rejects.toThrow(/needs an account/);
  });
});

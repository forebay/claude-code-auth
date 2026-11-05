import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NOW, useWorld } from "../../test/world.js";
import { decodeVerifier } from "../oauth/state.js";
import { createLoginAction } from "./login.js";

const world = useWorld();

function storeText(): string {
  return readFileSync(world().library.store, "utf8");
}

async function pastedCode(): Promise<string> {
  const answer = (await createLoginAction(world().dependencies)({})) as { url: string };
  const state = new URL(answer.url).searchParams.get("state") as string;
  return `the-code#${state}`;
}

describe("the login action", () => {
  it("answers the authorize url with the state carrying a verifier when given no code", async () => {
    const answer = (await createLoginAction(world().dependencies)({})) as { url: string; next: string };
    const url = new URL(answer.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${world().server.url}/oauth/authorize`);
    expect(url.searchParams.get("client_id")).toBe("client-under-test");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(decodeVerifier(url.searchParams.get("state") as string)).not.toBe("");
    expect(answer.next).toContain("code#state");
    expect(world().server.requests).toHaveLength(0);
  });

  it("treats a blank code as no code", async () => {
    expect(await createLoginAction(world().dependencies)({ code: "   " })).toHaveProperty("url");
  });

  it("completes in a second call that shares nothing with the first, exchanging with the verifier from the state", async () => {
    const first = (await createLoginAction(world().dependencies)({})) as { url: string };
    const verifier = decodeVerifier(new URL(first.url).searchParams.get("state") as string);
    const code = `the-code#${new URL(first.url).searchParams.get("state")}`;
    const answer = await createLoginAction(world().dependencies)({ code });
    expect(answer).toEqual({ id: "me@example.com", label: "me@example.com", outcome: "added" });
    const body = JSON.parse(world().server.requestsTo("/v1/oauth/token")[0]?.body ?? "");
    expect(body).toMatchObject({ code: "the-code", code_verifier: verifier, client_id: "client-under-test" });
  });

  it("keeps the tokens only in secrets, never in the store", async () => {
    await createLoginAction(world().dependencies)({ code: await pastedCode() });
    expect(world().secrets.entries.get("account.me@example.com.access")).toBe("access-from-grant");
    expect(world().secrets.entries.get("account.me@example.com.refresh")).toBe("refresh-from-grant");
    const text = storeText();
    expect(text).not.toMatch(/access|refresh|token/i);
    expect(JSON.parse(text).accounts[0]).toMatchObject({ id: "me@example.com", label: "me@example.com", enabled: true, expires: NOW + 3_600_000, addedAt: NOW });
  });

  it("accepts a pasted redirect url as well as code#state", async () => {
    const state = (await pastedCode()).split("#")[1] as string;
    const answer = await createLoginAction(world().dependencies)({ code: `https://platform.claude.com/oauth/code/callback?code=the-code&state=${state}` });
    expect(answer).toMatchObject({ outcome: "added" });
  });

  it("labels an account the upstream names only by its organisation with that name", async () => {
    world().server.tokenResponder = () => ({ status: 200, body: { refresh_token: "r", organization: { name: "Acme" } } });
    expect(await createLoginAction(world().dependencies)({ code: await pastedCode() })).toMatchObject({ id: "Acme" });
  });

  it("gives an account with no email or organisation an id that is not its refresh token", async () => {
    world().server.tokenResponder = () => ({ status: 200, body: { refresh_token: "secret-refresh" } });
    const answer = (await createLoginAction(world().dependencies)({ code: await pastedCode() })) as { id: string };
    expect(answer.id).toMatch(/^claude-[0-9a-f]{12}$/);
    expect(storeText()).not.toContain("secret-refresh");
  });

  it("signs the same account in again as an update, re-enabling it", async () => {
    await createLoginAction(world().dependencies)({ code: await pastedCode() });
    world().library.accounts.report({ store: world().library.store, id: "me@example.com", outcome: "disabled", reason: "re-login required", now: NOW });
    world().at(NOW + 5_000);
    const answer = await createLoginAction(world().dependencies)({ code: await pastedCode() });
    expect(answer).toMatchObject({ outcome: "updated" });
    const [account] = world().library.accounts.list({ store: world().library.store }).accounts ?? [];
    expect(account).toMatchObject({ enabled: true, addedAt: NOW });
    expect(account?.disabledReason ?? "").toBe("");
    expect(world().library.accounts.list({ store: world().library.store }).accounts).toHaveLength(1);
  });

  it("refuses a failed exchange, naming it, and stores nothing", async () => {
    world().server.tokenResponder = () => ({ status: 400, body: { error: "invalid_grant" } });
    await expect(createLoginAction(world().dependencies)({ code: await pastedCode() })).rejects.toThrow(/could not be completed: the token endpoint answered 400/);
    expect(world().secrets.entries.size).toBe(0);
    expect(world().library.accounts.list({ store: world().library.store }).accounts ?? []).toEqual([]);
  });

  it("refuses a paste that carries no state, without reaching the endpoint", async () => {
    await expect(createLoginAction(world().dependencies)({ code: "just-a-code" })).rejects.toThrow(/carries no state/);
    expect(world().server.requests).toHaveLength(0);
  });

  it("refuses a state with no verifier, without reaching the endpoint", async () => {
    await expect(createLoginAction(world().dependencies)({ code: `c#${Buffer.from("{}").toString("base64url")}` })).rejects.toThrow(/Missing PKCE verifier/);
    expect(world().server.requests).toHaveLength(0);
  });

  it("refuses, naming the cause, on a host with no secret store", async () => {
    const without = { ...world().dependencies, secrets: undefined };
    await expect(createLoginAction(without)({})).rejects.toThrow(/secret store/);
  });

  it("rolls the tokens back and fails with the refusal's cause and fix when the service refuses the account", async () => {
    const refusing = { ...world().dependencies, accounts: () => ({ ...world().library.accounts, upsert: () => ({ refused: "the store is read only", fix: "make it writable" }) }) };
    await expect(createLoginAction(refusing)({ code: await pastedCode() })).rejects.toThrow(/the store is read only.*make it writable/);
    expect(world().secrets.entries.size).toBe(0);
  });

  it("restores the previous tokens of an existing account when its re-login is refused", async () => {
    await createLoginAction(world().dependencies)({ code: await pastedCode() });
    world().server.tokenResponder = () => ({ status: 200, body: { access_token: "newer", refresh_token: "newer-refresh", account: { email_address: "me@example.com" } } });
    const refusing = { ...world().dependencies, accounts: () => ({ ...world().library.accounts, upsert: () => ({ refused: "no", fix: "retry" }) }) };
    await expect(createLoginAction(refusing)({ code: await pastedCode() })).rejects.toThrow(/no; retry/);
    expect(world().secrets.entries.get("account.me@example.com.refresh")).toBe("refresh-from-grant");
    expect(world().secrets.entries.get("account.me@example.com.access")).toBe("access-from-grant");
  });

  it("undoes the refresh token write when the access token write then fails", async () => {
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
    await expect(createLoginAction(failing)({ code: await pastedCode() })).rejects.toThrow("keychain locked");
    expect(secrets.entries.size).toBe(0);
  });

  it("removes the tokens again when the account cannot be stored", async () => {
    const refusing = { ...world().dependencies, accounts: () => ({ ...world().library.accounts, upsert: () => { throw new Error("store is locked"); } }) };
    await expect(createLoginAction(refusing)({ code: await pastedCode() })).rejects.toThrow(/store is locked/);
    expect(world().secrets.entries.size).toBe(0);
  });
});

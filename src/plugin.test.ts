import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccountsService, IrFailure, IrRequest, IrResponse, Provider } from "@forebay/host";
import type { PluginContext } from "@weivel/typescript";
import { fakeSecrets } from "../test/fake-secrets.js";
import { startOauthServer } from "../test/fixtures/oauth-server.js";
import type { OauthServer } from "../test/fixtures/oauth-server.js";
import { openTestAccounts } from "../test/accounts-library.js";
import type { TestAccounts } from "../test/accounts-library.js";
import { NEVER_ABORTED, settingsFor } from "../test/world.js";
import plugin from "./plugin.js";

const MANIFEST = JSON.parse(readFileSync(join(import.meta.dirname, "..", "plugin.json"), "utf8"));
const REQUEST: IrRequest = { model: "claude-sonnet-4", messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }], stream: false };

interface Hosted {
  provider: Provider;
  registered: Map<string, Record<string, (argument: unknown) => unknown>>;
  secrets: ReturnType<typeof fakeSecrets>;
  pluginDirectory: string;
  /** Runs an action the way the host does: the manifest's binding argument, the input and the row laid in that order. */
  runAction(actionId: string, input?: Record<string, unknown>, row?: Record<string, unknown>): Promise<unknown>;
}

let server: OauthServer;
let library: TestAccounts;
let directories: string[];

beforeEach(async () => {
  server = await startOauthServer();
  library = openTestAccounts();
  directories = [];
});

afterEach(async () => {
  await server.close();
  library.close();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

async function activated(accounts: AccountsService | null = library.accounts): Promise<Hosted> {
  const pluginDirectory = mkdtempSync(join(tmpdir(), "claude-code-provider-plugin-"));
  directories.push(pluginDirectory);
  const settings = settingsFor(server);
  const secrets = fakeSecrets();
  const provided = new Map<string, unknown>();
  const registered: Hosted["registered"] = new Map();
  const context = {
    capability: (id: string) => ({ id }),
    service: (id: string) => ({ id }),
    config: { get: (key: string) => settings[key], all: () => settings },
    paths: { plugin: pluginDirectory },
    host: { api: 1, app: "the-loader", surfaces: [] },
    manifest: MANIFEST,
    secrets,
    log: { warn: () => {} },
    provide: (type: { id: string }, implementation: unknown) => provided.set(type.id, implementation),
    services: {
      get: (type: { id: string }) => (type.id === "accounts" ? accounts ?? undefined : undefined),
      register: (type: { id: string }, implementation: Hosted["registered"] extends Map<string, infer V> ? V : never) => registered.set(type.id, implementation),
    },
  } as unknown as PluginContext;
  await plugin.activate(context);
  const runAction: Hosted["runAction"] = async (actionId, input = {}, row = {}) => {
    const binding = MANIFEST.actions[actionId].call as { service: string; method: string; argument?: Record<string, unknown> };
    return registered.get(binding.service)?.[binding.method]?.({ ...binding.argument, ...input, ...row });
  };
  return { provider: provided.get("provider") as Provider, registered, secrets, pluginDirectory, runAction };
}

describe("the manifest", () => {
  it("is a provider that consumes the accounts service, with the settings it always had and the three upstream urls", () => {
    expect(MANIFEST.id).toBe("claude-code-provider");
    expect(MANIFEST.capabilities).toEqual(["provider"]);
    expect(MANIFEST.services.consumes).toEqual(["accounts"]);
    expect(MANIFEST.config.defaults).toEqual({
      logging: true,
      max_account_attempts: 4,
      account_selection_strategy: "hybrid",
      default_cooldown_seconds: 60,
      max_cooldown_seconds: 900,
      oauth_authorize_url: "https://claude.ai/oauth/authorize",
      oauth_token_url: "https://platform.claude.com/v1/oauth/token",
      api_base_url: "https://api.anthropic.com",
    });
  });

  it("binds each action to a method of a service the plugin registers", async () => {
    const { registered } = await activated();
    expect(Object.keys(MANIFEST.actions).sort()).toEqual(["accounts", "login", "quota", "refresh", "remove", "verify"]);
    for (const action of Object.values(MANIFEST.actions) as Array<{ call: { service: string; method: string } }>) {
      expect(MANIFEST.services.provides).toContain(action.call.service);
      expect(typeof registered.get(action.call.service)?.[action.call.method]).toBe("function");
    }
  });
});

describe("the login action through the host's action path", () => {
  it("answers the url, then stores the account without its tokens and the tokens in secrets", async () => {
    const { runAction, secrets, pluginDirectory } = await activated();
    const first = (await runAction("login")) as { url: string };
    const state = new URL(first.url).searchParams.get("state");
    const second = await runAction("login", { code: `the-code#${state}` });
    expect(second).toEqual({ id: "me@example.com", label: "me@example.com", outcome: "added" });
    expect(secrets.entries.get("account.me@example.com.access")).toBe("access-from-grant");
    expect(secrets.entries.get("account.me@example.com.refresh")).toBe("refresh-from-grant");
    const store = readFileSync(join(pluginDirectory, "accounts.json"), "utf8");
    expect(store).not.toMatch(/access|refresh/);
    expect(library.accounts.list({ store: join(pluginDirectory, "accounts.json") }).accounts).toHaveLength(1);
  });

  it("then lists the account and lets models be fetched with its access token", async () => {
    const { runAction, provider } = await activated();
    const first = (await runAction("login")) as { url: string };
    await runAction("login", { code: `c#${new URL(first.url).searchParams.get("state")}` });
    expect(await runAction("accounts")).toMatchObject({ accounts: [{ id: "me@example.com", enabled: true }] });
    server.modelsResponder = () => ({ status: 200, body: { data: [{ id: "claude-sonnet-4", display_name: "Claude Sonnet 4" }] } });
    expect((await provider.models()).models.map((model) => model.id)).toEqual(["claude-sonnet-4"]);
    expect(server.requestsTo("/v1/models")[0]?.headers.authorization).toBe("Bearer access-from-grant");
  });
});

describe("the provider", () => {
  it("offers no models before any account is added, without calling the upstream", async () => {
    const { provider } = await activated();
    expect(await provider.models()).toEqual({ models: [] });
    expect(server.requests).toHaveLength(0);
  });

  it("skips an account whose token cannot be refreshed and lists the next account's models", async () => {
    const { provider, secrets, pluginDirectory } = await activated();
    const store = join(pluginDirectory, "accounts.json");
    library.accounts.upsert({ store, account: { id: "stale", enabled: true, expires: 1 } });
    library.accounts.upsert({ store, account: { id: "fresh", enabled: true, expires: Date.now() + 3_600_000 } });
    await secrets.set("account.stale.refresh", "r");
    await secrets.set("account.fresh.access", "fresh-access");
    server.tokenResponder = () => ({ status: 400, body: { error: "invalid_grant" } });
    server.modelsResponder = () => ({ status: 200, body: { data: [{ id: "claude-x" }] } });
    expect((await provider.models()).models.map((model) => model.id)).toEqual(["claude-x"]);
  });

  it("answers a request through the account a login stored, with its access token", async () => {
    const { runAction, provider } = await activated();
    const first = (await runAction("login")) as { url: string };
    await runAction("login", { code: `c#${new URL(first.url).searchParams.get("state")}` });
    server.messagesResponder = () => ({ status: 200, body: { id: "msg_7", type: "message", role: "assistant", content: [{ type: "text", text: "hello" }], model: "claude-sonnet-4", stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } });
    const answer = (await provider.handleIr(REQUEST, NEVER_ABORTED)) as IrResponse;
    expect(answer).toMatchObject({ id: "msg_7", content: [{ kind: "text", text: "hello" }] });
    expect(server.requestsTo("/v1/messages")[0]?.headers.authorization).toBe("Bearer access-from-grant");
  });

  it("answers 400 for a request before any account was added", async () => {
    const { provider } = await activated();
    const answer = (await provider.handleIr(REQUEST, NEVER_ABORTED)) as IrFailure;
    expect(answer.status).toBe(400);
    expect(JSON.parse(answer.body).error.message).toBe("No Claude account available, all accounts are disabled or logged out. Run `forebay-host action the-loader claude-code-provider login` to log one in.");
    expect(server.requests).toHaveLength(0);
  });

  it("refreshes an account's quota through the quota action and keeps it in the store", async () => {
    const { runAction, pluginDirectory } = await activated();
    const first = (await runAction("login")) as { url: string };
    await runAction("login", { code: `c#${new URL(first.url).searchParams.get("state")}` });
    server.usageResponder = () => ({ status: 200, body: { limits: [{ kind: "session", percent: 25, resets_at: "2025-07-16T12:00:00Z" }] } });
    const answer = (await runAction("quota")) as { results: Array<{ id: string; bars: unknown; hasCapacity: boolean }> };
    expect(answer.results).toEqual([{ id: "me@example.com", bars: [{ label: "5-hour", remainingFraction: 0.75, resetTime: Date.parse("2025-07-16T12:00:00Z") }], hasCapacity: true }]);
    const [stored] = library.accounts.list({ store: join(pluginDirectory, "accounts.json") }).accounts ?? [];
    expect(stored?.quota).toMatchObject({ pools: { "5h": { utilization: 0.25 } } });
  });

  it("never rejects from models: a missing accounts service answers no models", async () => {
    const { provider } = await activated(null);
    expect(await provider.models()).toEqual({ models: [] });
  });

  it("goes on to the next account when one account cannot be read", async () => {
    const { provider, secrets, pluginDirectory } = await activated();
    const store = join(pluginDirectory, "accounts.json");
    library.accounts.upsert({ store, account: { id: "broken", enabled: true, expires: Date.now() + 3_600_000 } });
    library.accounts.upsert({ store, account: { id: "fine", enabled: true, expires: Date.now() + 3_600_000 } });
    await secrets.set("account.fine.access", "fine-access");
    const originalGet = secrets.get;
    secrets.get = async (name: string) => {
      if (name.includes(".broken.")) throw new Error("keychain locked");
      return originalGet(name);
    };
    server.modelsResponder = () => ({ status: 200, body: { data: [{ id: "claude-y" }] } });
    expect((await provider.models()).models.map((model) => model.id)).toEqual(["claude-y"]);
  });

  it("deactivates without throwing", async () => {
    await expect(Promise.resolve(plugin.deactivate())).resolves.toBeUndefined();
  });
});

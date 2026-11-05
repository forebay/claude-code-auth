import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { IrFailure, IrRequest, IrResponse } from "@forebay/host";
import { anthropicTranslator } from "anthropic-translator";
import { openTestAccounts } from "../../test/accounts-library.js";
import type { TestAccounts } from "../../test/accounts-library.js";
import { startOauthServer } from "../../test/fixtures/oauth-server.js";
import type { OauthServer } from "../../test/fixtures/oauth-server.js";
import { MESSAGE } from "../../test/scenarios.js";
import { NOW, settingsFor } from "../../test/world.js";
import type { TokenAccess } from "../accounts/access.js";
import type { AccountDependencies } from "../accounts/dependencies.js";
import { readSettings } from "../settings.js";
import { createHandleIr } from "./handle-ir.js";
import { loginCommandOf } from "../accounts/dependencies.js";

const REQUEST: IrRequest = anthropicTranslator.decodeRequest({ model: "claude-sonnet-4", messages: [] });
const NEVER_ABORTED = new AbortController().signal;
const COOLDOWN = { baseMilliseconds: 60000, maxMilliseconds: 900000, random: 0.5 };

let server: OauthServer;
let library: TestAccounts;

beforeEach(async () => {
  server = await startOauthServer();
  library = openTestAccounts();
});

afterEach(async () => {
  await server.close();
  library.close();
});

function dependencies(strategy: string): AccountDependencies {
  const settings: Record<string, unknown> = { ...settingsFor(server), account_selection_strategy: strategy };
  return {
    accounts: () => library.accounts,
    store: library.store,
    secrets: undefined,
    settings: () => readSettings({ get: (key: string) => settings[key], all: () => settings } as never),
    clientId: () => "client",
    clock: () => NOW,
    random: () => 0.5,
    loginCommand: loginCommandOf("claude-code-loader", "claude-code-auth"),
    log: () => {},
  };
}

const access: TokenAccess = {
  ensureAccess: async (id) => ({ access: `token-of-${id}` }),
  refreshNow: async (id) => ({ access: `token-of-${id}` }),
};

function seed(ids: string[]): void {
  for (const id of ids) library.accounts.upsert({ store: library.store, account: { id, enabled: true } });
}

function stored(id: string) {
  return library.accounts.list({ store: library.store }).accounts?.find((account) => account.id === id);
}

describe("handleIr over the real accounts service", () => {
  it.each(["round-robin", "sticky", "hybrid"])("answers a 503 with when to retry, not a 400, when every account is cooling under %s", async (strategy) => {
    seed(["acc1", "acc2"]);
    for (const id of ["acc1", "acc2"]) library.accounts.report({ store: library.store, id, outcome: "error", now: NOW, ...COOLDOWN });
    const result = (await createHandleIr(dependencies(strategy), access)(REQUEST, NEVER_ABORTED)) as IrFailure;
    expect(result.status).toBe(503);
    expect(result.retryAfterMilliseconds).toBeGreaterThan(0);
    expect(server.requests).toHaveLength(0);
  });

  it("answers a 400 when there is no account at all", async () => {
    expect(((await createHandleIr(dependencies("round-robin"), access)(REQUEST, NEVER_ABORTED)) as IrFailure).status).toBe(400);
  });

  it("backs an account off by its attempt after a 429 without a reset, and serves from the next one", async () => {
    seed(["acc1", "acc2"]);
    let call = 0;
    server.messagesResponder = () => (call++ === 0 ? { status: 429, rawBody: "limited", headers: { "content-type": "text/plain" } } : { status: 200, rawBody: JSON.stringify(MESSAGE), headers: { "content-type": "application/json" } });
    const result = (await createHandleIr(dependencies("round-robin"), access)(REQUEST, NEVER_ABORTED)) as IrResponse;
    expect(result.id).toBe("msg_1");
    const limited = server.requestsTo("/v1/messages")[0]?.headers.authorization === "Bearer token-of-acc1" ? "acc1" : "acc2";
    expect((stored(limited)?.rateLimitResetTimes as Record<string, number>).messages).toBeGreaterThan(NOW);
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AccountsService, HandleIrResult, IrFailure, IrRequest, IrResponse, IrStreamEvent } from "@forebay/host";
import { anthropicTranslator } from "anthropic-translator";
import { startOauthServer } from "../../test/fixtures/oauth-server.js";
import type { OauthServer, Reply } from "../../test/fixtures/oauth-server.js";
import { MESSAGE, SCENARIOS } from "../../test/scenarios.js";
import type { Acquisition, Scenario } from "../../test/scenarios.js";
import { NOW, settingsFor } from "../../test/world.js";
import type { TokenAccess } from "../accounts/access.js";
import type { AccountDependencies } from "../accounts/dependencies.js";
import { readSettings } from "../settings.js";
import { createHandleIr } from "./handle-ir.js";

type Call = unknown[];

interface Oracle {
  name: string;
  snap: { status: number; headers: Record<string, string>; body: string };
  calls: Call[];
  outbound: Array<{ url: string; headers: Record<string, string>; body: string }>;
}

const ORACLE: Oracle[] = JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "test", "vectors", "handle-scenarios.expected.json"), "utf8"));
const REQUEST: IrRequest = anthropicTranslator.decodeRequest({ model: "claude-sonnet-4", messages: [] });
const NEVER_ABORTED = new AbortController().signal;
const TRANSPORT_FAILED = "<transport-failed>";

let server: OauthServer;
let events: Call[];
let logged: string[];

beforeEach(async () => {
  server = await startOauthServer();
  events = [];
  logged = [];
});

afterEach(async () => {
  await server.close();
});

function recordedReport(argument: Parameters<AccountsService["report"]>[0]): Call {
  const lane = argument.lane ?? "messages";
  switch (argument.outcome) {
    case "success": return ["manager.reportSuccess", argument.id];
    case "rate-limited": return argument.resetAt === undefined ? ["manager.reportRateLimit", argument.id, lane, "backoff", argument.attempt] : ["manager.reportRateLimit", argument.id, lane, argument.resetAt];
    case "error": return ["manager.reportError", argument.id, lane, argument.attempt, argument.reason === "transport failed" ? TRANSPORT_FAILED : argument.reason];
    case "disabled": return ["manager.disable", argument.id, argument.reason];
    default: return ["manager.captureQuota", argument.id, (argument.quota as { pools: unknown }).pools];
  }
}

function answerOf(acquisition: Acquisition): ReturnType<AccountsService["acquire"]> {
  if (acquisition === null) return { none: true };
  if (acquisition === "cooling") return { id: "acc1", available: false, availableAt: NOW + 60000 };
  return { id: acquisition.id, available: true };
}

function scriptedAccounts(acquisitions: Acquisition[], accountIds: string[]): AccountsService {
  let turn = 0;
  return {
    acquire: () => {
      const acquisition = acquisitions[turn++] ?? null;
      const answer = answerOf(acquisition);
      events.push(["manager.acquire", "messages", answer.id !== undefined && answer.available !== false ? answer.id : null]);
      return answer;
    },
    report: (argument: Parameters<AccountsService["report"]>[0]) => {
      events.push(recordedReport(argument));
      return { changed: true };
    },
    list: () => ({ accounts: accountIds.map((id) => ({ id, enabled: true })) }),
  } as unknown as AccountsService;
}

function scriptedAccess(acquisitions: Acquisition[]): TokenAccess {
  const accessOf = new Map(acquisitions.flatMap((acquisition) => (acquisition !== null && acquisition !== "cooling" ? [[acquisition.id, acquisition.access] as const] : [])));
  const ensure = async (id: string) => ((accessOf.get(id) ?? "") === "" ? { none: true as const, reason: "missing access token" } : { access: accessOf.get(id) as string });
  return { ensureAccess: ensure, refreshNow: ensure };
}

function scripted(replies: Reply[]): void {
  let call = 0;
  server.messagesResponder = () => replies[call++] ?? { status: 500, body: { script: "exhausted" } };
}

function dependenciesFor(accounts: AccountsService, overrides: Record<string, unknown> = {}): AccountDependencies {
  const settings = { ...settingsFor(server), ...overrides };
  return {
    accounts: () => accounts,
    store: "scripted-store",
    secrets: undefined,
    settings: () => readSettings({ get: (key: string) => settings[key], all: () => settings } as never),
    clientId: () => "client",
    clock: () => NOW,
    random: () => 0.5,
    log: (message) => logged.push(message),
  };
}

function handleIrFor(scenario: Scenario, overrides: Record<string, unknown> = {}) {
  const accounts = scriptedAccounts(scenario.acquire, scenario.accounts);
  scripted(scenario.upstream);
  return createHandleIr(dependenciesFor(accounts, overrides), scriptedAccess(scenario.acquire));
}

/** The oracle's calls in the vocabulary of the accounts service: no proxy pool, one disable, quota captured, a header-less limit backed off by its attempt. */
function expectedCalls(scenario: Scenario, oracle: Oracle): Call[] {
  if (scenario.calls !== undefined) return scenario.calls;
  const expected: Call[] = [];
  for (const call of oracle.calls) {
    const kind = call[0] as string;
    if (kind.startsWith("proxy.")) continue;
    if (kind === "manager.reportError" && call[4] === "403 scope") continue;
    if (kind === "manager.mutate") {
      const snapshot = call[2] as { cachedQuota?: { pools: unknown }; disabledReason?: string };
      expected.push(snapshot.cachedQuota === undefined ? ["manager.disable", call[1], snapshot.disabledReason] : ["manager.captureQuota", call[1], snapshot.cachedQuota.pools]);
    } else if (kind === "manager.reportRateLimit" && scenario.headerless !== undefined) {
      const attempt = expected.filter((entry) => entry[0] === "manager.acquire").length - 1;
      expected.push(["manager.reportRateLimit", call[1], call[2], "backoff", attempt]);
    } else {
      expected.push(call);
    }
  }
  return expected;
}

function isFailure(result: HandleIrResult): result is IrFailure {
  return typeof result === "object" && result !== null && "status" in result && "body" in result;
}

describe("the 16 scenarios of the parity oracle, through handleIr against a scripted loopback upstream", () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const oracle = ORACLE.find((entry) => entry.name === scenario.name) as Oracle;
      expect(oracle, `the oracle has no scenario ${scenario.name}`).toBeDefined();
      const result = await handleIrFor(scenario)(REQUEST, NEVER_ABORTED);

      expect(events).toEqual(expectedCalls(scenario, oracle));

      const sent = server.requestsTo("/v1/messages");
      expect(sent).toHaveLength(scenario.calls === undefined ? oracle.outbound.length : scenario.upstream.length);
      sent.forEach((request, index) => {
        const wanted = oracle.outbound[Math.min(index, oracle.outbound.length - 1)] as Oracle["outbound"][number];
        expect(request.method).toBe("POST");
        expect(request.headers).toMatchObject(wanted.headers);
        expect(JSON.parse(request.body)).toEqual(JSON.parse(wanted.body));
      });

      if (oracle.snap.status === 200) {
        expect(isFailure(result)).toBe(false);
        expect((result as IrResponse).id).toBe(MESSAGE.id);
        expect((result as IrResponse).content).toMatchObject([{ kind: "text", text: "hi" }]);
      } else {
        const failure = result as IrFailure;
        expect(failure.status).toBe(oracle.snap.status);
        expect(failure.body).toBe(oracle.snap.body);
        expect(failure.headers).toMatchObject(oracle.snap.headers);
      }
    });
  }
});

describe("the request path beyond the oracle", () => {
  const twoAccounts: Acquisition[] = [{ id: "acc1", access: "tok1" }, { id: "acc2", access: "tok2" }];

  it("stops after max_account_attempts turns", async () => {
    const acquire: Acquisition[] = [{ id: "acc1", access: "t1" }, { id: "acc2", access: "t2" }, { id: "acc3", access: "t3" }];
    const handle = handleIrFor({ name: "x", accounts: [], acquire, upstream: [{ status: 429, rawBody: "limited", headers: {} }, { status: 429, rawBody: "limited", headers: {} }, { status: 200, rawBody: JSON.stringify(MESSAGE), headers: { "content-type": "application/json" } }] }, { max_account_attempts: 2 });
    expect(((await handle(REQUEST, NEVER_ABORTED)) as IrFailure).status).toBe(429);
    expect(server.requestsTo("/v1/messages")).toHaveLength(2);
  });

  it("serves the upstream's error as it came, with its bytes and headers, and reports nothing for it", async () => {
    const handle = handleIrFor({ name: "x", accounts: [], acquire: twoAccounts, upstream: [{ status: 400, rawBody: '{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}', headers: { "content-type": "application/json", "request-id": "req_9" } }] });
    const result = (await handle(REQUEST, NEVER_ABORTED)) as IrFailure;
    expect(result).toMatchObject({ status: 400, body: '{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}', headers: { "request-id": "req_9" } });
    expect(events).toEqual([["manager.acquire", "messages", "acc1"]]);
  });

  it("reports the quota the response's headers carry, merged over the pools already stored", async () => {
    const accounts = scriptedAccounts(twoAccounts, []);
    (accounts as unknown as { list: unknown }).list = () => ({ accounts: [{ id: "acc1", enabled: true, quota: { pools: { "7d": { utilization: 0.9 }, "5h": { utilization: 0.1 } } } }] });
    scripted([{ status: 200, rawBody: JSON.stringify(MESSAGE), headers: { "content-type": "application/json", "anthropic-ratelimit-unified-5h-utilization": "0.5" } }]);
    await createHandleIr(dependenciesFor(accounts), scriptedAccess(twoAccounts))(REQUEST, NEVER_ABORTED);
    expect(events).toContainEqual(["manager.captureQuota", "acc1", { "7d": { utilization: 0.9 }, "5h": { utilization: 0.5 } }]);
  });

  it("decodes a 2xx event stream into IR events, never buffered", async () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"claude-sonnet-4","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":3,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");
    const handle = handleIrFor({ name: "x", accounts: [], acquire: twoAccounts, upstream: [{ status: 200, rawBody: sse, headers: { "content-type": "text/event-stream" } }] });
    const result = (await handle({ ...REQUEST, stream: true }, NEVER_ABORTED)) as AsyncIterable<IrStreamEvent>;
    const seen: string[] = [];
    for await (const event of result) seen.push(event.event);
    expect(seen).toEqual(["message_start", "content_block_start", "text_delta", "content_block_stop", "message_delta", "message_stop"]);
  });

  it("answers a 503 carrying when to retry for accounts that are all cooling, however the service says so", async () => {
    const cooling = handleIrFor({ name: "x", accounts: [], acquire: ["cooling"], upstream: [] });
    expect(await cooling(REQUEST, NEVER_ABORTED)).toMatchObject({ status: 503, retryAfterMilliseconds: 60000 });
    const accounts = { acquire: () => ({ none: true, nextAvailableAt: NOW + 5000 }) } as unknown as AccountsService;
    const none = await createHandleIr(dependenciesFor(accounts), scriptedAccess([]))(REQUEST, NEVER_ABORTED);
    expect(none).toMatchObject({ status: 503, retryAfterMilliseconds: 5000 });
  });

  it("answers an abort while the 2xx body is being read as an abort, not as a body that is not a message", async () => {
    const handle = handleIrFor({ name: "x", accounts: [], acquire: twoAccounts, upstream: [{ status: 200, stall: true, headers: { "content-type": "application/json" } }] });
    const aborter = new AbortController();
    const running = handle(REQUEST, aborter.signal);
    setTimeout(() => aborter.abort(new Error("client went away")), 100);
    await expect(running).rejects.toThrow();
  });

  it("answers a 502 for a 2xx body that is not a message", async () => {
    const handle = handleIrFor({ name: "x", accounts: [], acquire: twoAccounts, upstream: [{ status: 200, rawBody: "not json", headers: { "content-type": "application/json" } }] });
    expect(((await handle(REQUEST, NEVER_ABORTED)) as IrFailure).status).toBe(502);
  });

  it("answers a failure naming the cause and fix when the accounts service refuses to pick an account", async () => {
    const accounts = { acquire: () => ({ refused: "the store is unreadable", fix: "repair accounts.json" }) } as unknown as AccountsService;
    const result = (await createHandleIr(dependenciesFor(accounts), scriptedAccess([]))(REQUEST, NEVER_ABORTED)) as IrFailure;
    expect(result.status).toBe(500);
    expect(result.body).toMatch(/the store is unreadable; repair accounts.json/);
  });

  it("logs a refused report and still serves the answer", async () => {
    const accounts = scriptedAccounts(twoAccounts, []);
    accounts.report = (() => ({ refused: "the store is read only", fix: "make it writable" })) as never;
    scripted([{ status: 200, rawBody: JSON.stringify(MESSAGE), headers: { "content-type": "application/json" } }]);
    const result = await createHandleIr(dependenciesFor(accounts), scriptedAccess(twoAccounts))(REQUEST, NEVER_ABORTED);
    expect((result as IrResponse).id).toBe("msg_1");
    expect(logged.join()).toMatch(/the store is read only; make it writable/);
  });

  it("rotates past an account whose token cannot be had, reporting why, without sending a request for it", async () => {
    const accounts = scriptedAccounts(twoAccounts, []);
    scripted([{ status: 200, rawBody: JSON.stringify(MESSAGE), headers: { "content-type": "application/json" } }]);
    const access: TokenAccess = { ensureAccess: async (id) => (id === "acc1" ? { none: true, reason: "re-login required" } : { access: "tok2" }), refreshNow: async () => ({ none: true, reason: "unused" }) };
    await createHandleIr(dependenciesFor(accounts), access)(REQUEST, NEVER_ABORTED);
    expect(events[1]).toEqual(["manager.reportError", "acc1", "messages", 0, "re-login required"]);
    expect(server.requestsTo("/v1/messages")).toHaveLength(1);
  });
});

describe("a caller's abort", () => {
  const acquire: Acquisition[] = [{ id: "acc1", access: "tok1" }, { id: "acc2", access: "tok2" }];

  it("mid request rejects and reports nothing, neither an error nor a success", async () => {
    const handle = handleIrFor({ name: "x", accounts: [], acquire, upstream: [{ status: 200, rawBody: JSON.stringify(MESSAGE), headers: { "content-type": "application/json" }, delayMilliseconds: 500 }] });
    const aborter = new AbortController();
    const running = handle(REQUEST, aborter.signal);
    setTimeout(() => aborter.abort(new Error("client went away")), 50);
    await expect(running).rejects.toThrow();
    expect(events).toEqual([["manager.acquire", "messages", "acc1"]]);
  });

  it("before the first turn rejects without taking an account", async () => {
    const aborter = new AbortController();
    aborter.abort(new Error("gone"));
    await expect(handleIrFor({ name: "x", accounts: [], acquire, upstream: [] })(REQUEST, aborter.signal)).rejects.toThrow("gone");
    expect(events).toEqual([]);
  });

  it("while an access token is being had rejects and reports nothing", async () => {
    const accounts = scriptedAccounts(acquire, []);
    const aborter = new AbortController();
    const access: TokenAccess = { ensureAccess: async () => { aborter.abort(new Error("gone")); aborter.signal.throwIfAborted(); return { none: true, reason: "x" }; }, refreshNow: async () => ({ none: true, reason: "x" }) };
    await expect(createHandleIr(dependenciesFor(accounts), access)(REQUEST, aborter.signal)).rejects.toThrow("gone");
    expect(events).toEqual([["manager.acquire", "messages", "acc1"]]);
  });
});

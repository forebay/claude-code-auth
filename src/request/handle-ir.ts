import { TextDecoderStream } from "node:stream/web";
import type { AccountsService, HandleIrResult, IrFailure, IrRequest, IrStreamEvent } from "@forebay/host";
import { anthropicTranslator } from "anthropic-translator";
import type { AccessAnswer, TokenAccess } from "../accounts/access.js";
import { accepted } from "../accounts/dependencies.js";
import type { AccountDependencies } from "../accounts/dependencies.js";
import { INFERENCE_SCOPE_REASON, MESSAGES_LANE } from "../constants.js";
import { isRateLimitStatus, sendAttempt } from "./attempt.js";
import type { Attempt } from "./attempt.js";
import { captureQuota } from "./capture-quota.js";
import { reportAttempt } from "./report.js";
import { parseResetMs } from "./reset.js";
import { rewrite } from "./rewrite.js";

const NO_ACCOUNT_MESSAGE = "No Claude account available, all accounts are disabled or logged out. Run `cc auth` to add or re-enable one.";
const ALL_COOLING_MESSAGE = "No Claude account free right now (all rate-limited). Try again shortly.";

type Received = Extract<Attempt, { kind: "response" }>;

/** A turn either ends the request with an answer, or rotates on, remembering the real upstream failure it saw, if any. */
type Turn = { answer: HandleIrResult } | { rotated: IrFailure | undefined };

function failure(status: number, body: string, headers: Record<string, string> = { "content-type": "application/json" }): IrFailure {
  return { status, headers, body };
}

function errorBody(message: string): string {
  return JSON.stringify({ error: { message } });
}

function noAccount(): IrFailure {
  const body = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: NO_ACCOUNT_MESSAGE } });
  return failure(400, body, { "content-type": "application/json", "x-hub-chat-error": "1" });
}

async function upstreamFailure(received: Received): Promise<IrFailure> {
  return { status: received.response.status, headers: received.headers, body: await received.response.text() };
}

async function* eventsOf(response: Response): AsyncGenerator<IrStreamEvent> {
  const text = (response.body as ReadableStream<Uint8Array>).pipeThrough(new TextDecoderStream() as never);
  const reader = (text.pipeThrough(anthropicTranslator.decodeStream() as never) as ReadableStream<IrStreamEvent>).getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function decoded(response: Response): Promise<HandleIrResult> {
  if (response.headers.get("content-type")?.includes("text/event-stream") === true && response.body !== null) return eventsOf(response);
  try {
    return anthropicTranslator.decodeResponse(JSON.parse(await response.text()));
  } catch {
    return failure(502, errorBody("the upstream answered a body that is not a message"));
  }
}

/**
 * Builds the `handleIr` of the plugin: up to `max_account_attempts` turns, each taking an account
 * from the `accounts` service, getting its access token, sending one request and reporting what
 * happened to that account.
 *
 * @remarks A 429 or 529 rotates, reporting the reset the response named, else an error that backs the
 * account off by its attempt. A 401 rotates, a 403 disables the account, any other status is the
 * answer as the upstream gave it. No account at all is a 400, accounts that are all cooling a 503,
 * and running out of turns answers the last real upstream failure, else a 502. A caller's abort
 * rejects at any point and reports nothing.
 */
export function createHandleIr(dependencies: AccountDependencies, access: TokenAccess): (request: IrRequest, signal: AbortSignal) => Promise<HandleIrResult> {
  async function ensured(id: string, signal: AbortSignal): Promise<AccessAnswer> {
    try {
      return await access.ensureAccess(id, dependencies.clock(), signal);
    } catch (cause) {
      if (signal.aborted) throw cause;
      return { none: true, reason: cause instanceof Error ? cause.message : String(cause) };
    }
  }

  async function afterResponse(id: string, attemptNumber: number, received: Received): Promise<Turn> {
    const status = received.response.status;
    captureQuota(dependencies, id, received.headers);
    if (isRateLimitStatus(status)) {
      const resetAt = parseResetMs(received.headers, dependencies.clock());
      reportAttempt(dependencies, id, resetAt === undefined ? { outcome: "error", attempt: attemptNumber, reason: `${status} rate limited` } : { outcome: "rate-limited", resetAt });
      return { rotated: await upstreamFailure(received) };
    }
    if (status === 401) {
      reportAttempt(dependencies, id, { outcome: "error", attempt: attemptNumber, reason: "401 unauthorized" });
      return { rotated: await upstreamFailure(received) };
    }
    if (status === 403) {
      reportAttempt(dependencies, id, { outcome: "disabled", reason: INFERENCE_SCOPE_REASON });
      return { rotated: await upstreamFailure(received) };
    }
    if (!received.response.ok) return { answer: await upstreamFailure(received) };
    reportAttempt(dependencies, id, { outcome: "success" });
    return { answer: await decoded(received.response) };
  }

  function acquiredAccount(acquisition: Parameters<AccountsService["acquire"]>[0]): { account: ReturnType<AccountsService["acquire"]> } | { failure: IrFailure } {
    try {
      return { account: accepted(dependencies.accounts().acquire(acquisition), "could not pick an account") };
    } catch (cause) {
      return { failure: failure(500, errorBody(cause instanceof Error ? cause.message : String(cause))) };
    }
  }

  async function turn(request: IrRequest, signal: AbortSignal, attemptNumber: number): Promise<Turn> {
    const settings = dependencies.settings();
    const acquisition = { store: dependencies.store, lane: MESSAGES_LANE, strategy: settings.accountSelectionStrategy, now: dependencies.clock() };
    const acquired = acquiredAccount(acquisition);
    if ("failure" in acquired) return { answer: acquired.failure };
    const { account } = acquired;
    if (account.none === true || account.id === undefined) return { answer: noAccount() };
    if (account.available === false) return { answer: failure(503, errorBody(ALL_COOLING_MESSAGE)) };
    const id = account.id;
    const token = await ensured(id, signal);
    if ("none" in token) {
      reportAttempt(dependencies, id, { outcome: "error", attempt: attemptNumber, reason: token.reason });
      return { rotated: undefined };
    }
    const attempt = await sendAttempt(rewrite(request, token.access, settings.apiBase), signal);
    if (attempt.kind === "transport-failed") {
      reportAttempt(dependencies, id, { outcome: "error", attempt: attemptNumber, reason: "transport failed" });
      return { rotated: undefined };
    }
    return afterResponse(id, attemptNumber, attempt);
  }

  return async (request, signal) => {
    const turns = dependencies.settings().maxAccountAttempts;
    let last: IrFailure | undefined;
    for (let attemptNumber = 0; attemptNumber < turns; attemptNumber++) {
      signal.throwIfAborted();
      const result = await turn(request, signal, attemptNumber);
      if ("answer" in result) return result.answer;
      last = result.rotated ?? last;
    }
    return last ?? failure(502, errorBody(`Claude request failed after ${turns} attempts`));
  };
}

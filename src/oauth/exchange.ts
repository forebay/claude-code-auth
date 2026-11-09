import { CLAUDE_REDIRECT_URI } from "../constants.js";
import { describeRefusal, expiryOf, isTimeout, jsonBodyOf, objectMember, textMember } from "./token-set.js";
import type { TokenSet } from "./token-set.js";

export interface ExchangeRequest {
  tokenUrl: string;
  clientId: string;
  code: string;
  state: string;
  verifier: string;
  now: number;
  signal?: AbortSignal;
}

export type ExchangeOutcome = { ok: true; tokens: TokenSet; label?: string } | { ok: false; error: string };

function failure(error: string): ExchangeOutcome {
  return { ok: false, error };
}

/** The account's email, else the organisation's name, which is how a subscription account is told apart. */
function labelOf(payload: unknown): string | undefined {
  const account = objectMember(payload, "account");
  return textMember(account, "email_address") ?? textMember(account, "email") ?? textMember(objectMember(payload, "organization"), "name");
}

async function post(request: ExchangeRequest): Promise<Response> {
  return fetch(request.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: request.clientId,
      code: request.code,
      redirect_uri: CLAUDE_REDIRECT_URI,
      code_verifier: request.verifier,
      state: request.state,
    }),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
}

function outcomeOf(payload: unknown, now: number): ExchangeOutcome {
  const refresh = textMember(payload, "refresh_token");
  if (refresh === undefined) return failure("missing refresh token in response");
  const access = textMember(payload, "access_token");
  const label = labelOf(payload);
  return { ok: true, tokens: { ...(access === undefined ? {} : { access }), refresh, expires: expiryOf(now, objectMember(payload, "expires_in")) }, ...(label === undefined ? {} : { label }) };
}

/**
 * Trades the pasted authorization code for tokens. Every way the exchange can fail answers a reason
 * rather than throwing, and the reason never carries a code, verifier or token.
 */
export async function exchangeCode(request: ExchangeRequest): Promise<ExchangeOutcome> {
  let response: Response;
  try {
    response = await post(request);
  } catch (cause) {
    if (isTimeout(cause)) return failure("the token endpoint did not answer in time");
    if (request.signal?.aborted === true) throw cause;
    return failure("the token endpoint could not be reached");
  }
  if (!response.ok) return failure(describeRefusal(response.status, textMember(await jsonBodyOf(response), "error")));
  const payload = await jsonBodyOf(response);
  return payload === undefined ? failure("the token endpoint answered a body that is not JSON") : outcomeOf(payload, request.now);
}

import { expiryOf, jsonBodyOf, objectMember, textMember } from "./token-set.js";
import type { TokenSet } from "./token-set.js";

export interface RefreshRequest {
  tokenUrl: string;
  clientId: string;
  refreshToken: string;
  now: number;
  signal?: AbortSignal;
}

/** `revoked` is true when the endpoint refused the refresh token itself (`invalid_grant`), so only a new login helps. */
export type RefreshOutcome = { ok: true; tokens: Required<TokenSet> } | { ok: false; revoked: boolean; message: string };

const REVOKED_CODE = "invalid_grant";

async function post(request: RefreshRequest): Promise<Response> {
  return fetch(request.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: request.refreshToken, client_id: request.clientId }).toString(),
    ...(request.signal === undefined ? {} : { signal: request.signal }),
  });
}

async function refusal(response: Response): Promise<RefreshOutcome> {
  const code = textMember(await jsonBodyOf(response), "error");
  return { ok: false, revoked: code === REVOKED_CODE, message: `the token endpoint answered ${response.status}${code === undefined ? "" : ` (${code})`}` };
}

function tokensOf(payload: unknown, request: RefreshRequest): RefreshOutcome {
  const access = textMember(payload, "access_token");
  if (access === undefined) return { ok: false, revoked: false, message: "the token endpoint answered no access token" };
  return { ok: true, tokens: { access, refresh: textMember(payload, "refresh_token") ?? request.refreshToken, expires: expiryOf(request.now, objectMember(payload, "expires_in")) } };
}

/** Trades a refresh token for a new access token, keeping the refresh token when the endpoint rotates none. */
export async function refreshTokens(request: RefreshRequest): Promise<RefreshOutcome> {
  let response: Response;
  try {
    response = await post(request);
  } catch (cause) {
    if (request.signal?.aborted === true) throw cause;
    return { ok: false, revoked: false, message: "the token endpoint could not be reached" };
  }
  if (!response.ok) return refusal(response);
  const payload = await jsonBodyOf(response);
  return payload === undefined ? { ok: false, revoked: false, message: "the token endpoint answered a body that is not JSON" } : tokensOf(payload, request);
}

import { randomBytes } from "node:crypto";
import { CLAUDE_REDIRECT_URI, CLAUDE_SCOPES } from "../constants.js";
import type { PendingLogin } from "./pending-login.js";
import { createPkce } from "./pkce.js";

const STATE_BYTES = 32;

export interface AuthorizeOptions {
  authorizeUrl: string;
  clientId: string;
  entropy?: (size: number) => Buffer;
}

export interface AuthorizationRequest {
  url: string;
  pending: PendingLogin;
}

/** The URL a user opens to grant a subscription token, and the sign in the caller must keep to complete it. */
export function authorizationRequest(options: AuthorizeOptions): AuthorizationRequest {
  const entropy = options.entropy ?? randomBytes;
  const pkce = createPkce(entropy);
  const state = entropy(STATE_BYTES).toString("base64url");
  const url = new URL(options.authorizeUrl);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", CLAUDE_REDIRECT_URI);
  url.searchParams.set("scope", CLAUDE_SCOPES.join(" "));
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", state);
  return { url: url.toString(), pending: { state, verifier: pkce.verifier } };
}

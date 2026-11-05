import { CLAUDE_REDIRECT_URI, CLAUDE_SCOPES } from "../constants.js";
import { createPkce } from "./pkce.js";
import { encodeState } from "./state.js";

export interface AuthorizeOptions {
  authorizeUrl: string;
  clientId: string;
  entropy?: (size: number) => Buffer;
}

/**
 * The URL a user opens to grant a subscription token, its `state` carrying the PKCE verifier so the
 * exchange can run in another process.
 */
export function authorizationUrl(options: AuthorizeOptions): string {
  const pkce = createPkce(options.entropy);
  const url = new URL(options.authorizeUrl);
  url.searchParams.set("code", "true");
  url.searchParams.set("client_id", options.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", CLAUDE_REDIRECT_URI);
  url.searchParams.set("scope", CLAUDE_SCOPES.join(" "));
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("state", encodeState(pkce.verifier));
  return url.toString();
}

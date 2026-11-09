import { createHash } from "node:crypto";
import { authorizationRequest } from "../oauth/authorize.js";
import { exchangeCode } from "../oauth/exchange.js";
import { parsePastedCallback } from "../oauth/paste.js";
import { claimVerifier, rememberPendingLogin } from "../oauth/pending-login.js";
import type { TokenSet } from "../oauth/token-set.js";
import { accepted, accessSecretName, findAccount, refreshSecretName, secretsOf } from "./dependencies.js";
import type { AccountDependencies } from "./dependencies.js";

export type LoginAnswer =
  | { url: string; next: string }
  | { id: string; label: string; outcome: "added" | "updated" | "unchanged" };

const NEXT_STEP = "open the url, sign in, then run login again with the code shown (code#state) as the code input";
const FALLBACK_ID_DIGITS = 12;
const EXCHANGE_TIMEOUT_MILLISECONDS = 30000;

/** @implNote An account the upstream names neither by email nor by organisation still needs a stable id, and the refresh token itself must never become one. */
function accountIdOf(label: string | undefined, tokens: TokenSet): string {
  return label ?? `claude-${createHash("sha256").update(tokens.refresh).digest("hex").slice(0, FALLBACK_ID_DIGITS)}`;
}

async function storeTokens(dependencies: AccountDependencies, id: string, tokens: TokenSet): Promise<void> {
  const secrets = secretsOf(dependencies);
  await secrets.set(refreshSecretName(id), tokens.refresh);
  if (tokens.access === undefined) await secrets.delete(accessSecretName(id));
  else await secrets.set(accessSecretName(id), tokens.access);
}

interface PreviousTokens {
  access: string | undefined;
  refresh: string | undefined;
}

async function previousTokens(dependencies: AccountDependencies, id: string): Promise<PreviousTokens> {
  const secrets = secretsOf(dependencies);
  return { access: await secrets.get(accessSecretName(id)), refresh: await secrets.get(refreshSecretName(id)) };
}

async function restoreSecret(dependencies: AccountDependencies, name: string, value: string | undefined): Promise<void> {
  const secrets = secretsOf(dependencies);
  if (value === undefined) await secrets.delete(name);
  else await secrets.set(name, value);
}

async function restoreTokens(dependencies: AccountDependencies, id: string, previous: PreviousTokens): Promise<void> {
  await restoreSecret(dependencies, accessSecretName(id), previous.access);
  await restoreSecret(dependencies, refreshSecretName(id), previous.refresh);
}

function upsertAccount(dependencies: AccountDependencies, id: string, tokens: TokenSet): "added" | "updated" | "unchanged" {
  const existing = findAccount(dependencies, id);
  const account = {
    id,
    label: id,
    enabled: true,
    expires: tokens.expires,
    ...(existing === undefined ? { addedAt: dependencies.clock() } : {}),
    ...(existing?.disabledReason === undefined || existing.disabledReason === "" ? {} : { disabledReason: "" }),
  };
  const answer = accepted(dependencies.accounts().upsert({ store: dependencies.store, account }), "the account could not be stored");
  return answer.outcome ?? "updated";
}

async function complete(dependencies: AccountDependencies, pasted: { code: string; state: string }): Promise<LoginAnswer> {
  const verifier = await claimVerifier(secretsOf(dependencies), pasted.state);
  const exchanged = await exchangeCode({ tokenUrl: dependencies.settings().tokenUrl, clientId: dependencies.clientId(), code: pasted.code, state: pasted.state, verifier, now: dependencies.clock(), signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MILLISECONDS) });
  if (!exchanged.ok) throw new Error(`the sign in could not be completed: ${exchanged.error}; run login without a code for a new url`);
  const id = accountIdOf(exchanged.label, exchanged.tokens);
  const previous = await previousTokens(dependencies, id);
  try {
    await storeTokens(dependencies, id, exchanged.tokens);
    return { id, label: id, outcome: upsertAccount(dependencies, id, exchanged.tokens) };
  } catch (cause) {
    await restoreTokens(dependencies, id, previous);
    throw cause;
  }
}

/**
 * The `login` action. With no `code` it answers the authorize url; with the pasted `code#state` it
 * exchanges it, keeps the tokens in the plugin's secrets and the account, without them, in the store.
 *
 * @remarks Each call may be its own process, so the two steps share only the plugin's secrets, which
 * hold the PKCE verifier against the random `state` the url carries.
 */
export function createLoginAction(dependencies: AccountDependencies): (input: { code?: unknown }) => Promise<LoginAnswer> {
  return async (input) => {
    secretsOf(dependencies);
    const pasted = parsePastedCallback(typeof input.code === "string" ? input.code : undefined);
    if (pasted === undefined) {
      const { url, pending } = authorizationRequest({ authorizeUrl: dependencies.settings().authorizeUrl, clientId: dependencies.clientId() });
      await rememberPendingLogin(secretsOf(dependencies), pending);
      return { url, next: NEXT_STEP };
    }
    if (pasted.state === undefined) throw new Error("the pasted text carries no state; paste the whole code#state shown after signing in");
    return complete(dependencies, { code: pasted.code, state: pasted.state });
  };
}

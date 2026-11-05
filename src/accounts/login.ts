import { createHash } from "node:crypto";
import { authorizationUrl } from "../oauth/authorize.js";
import { exchangeCode } from "../oauth/exchange.js";
import { parsePastedCallback } from "../oauth/paste.js";
import type { TokenSet } from "../oauth/token-set.js";
import { accessSecretName, findAccount, refreshSecretName, secretsOf } from "./dependencies.js";
import type { AccountDependencies } from "./dependencies.js";

export type LoginAnswer =
  | { url: string; next: string }
  | { id: string; label: string; outcome: "added" | "updated" | "unchanged" };

const NEXT_STEP = "open the url, sign in, then run login again with the code shown (code#state) as the code input";
const FALLBACK_ID_DIGITS = 12;

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

async function removeTokens(dependencies: AccountDependencies, id: string): Promise<void> {
  const secrets = secretsOf(dependencies);
  await secrets.delete(accessSecretName(id));
  await secrets.delete(refreshSecretName(id));
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
  return dependencies.accounts().upsert({ store: dependencies.store, account }).outcome ?? "updated";
}

async function complete(dependencies: AccountDependencies, pasted: { code: string; state: string }): Promise<LoginAnswer> {
  const exchanged = await exchangeCode({ tokenUrl: dependencies.settings().tokenUrl, clientId: dependencies.clientId(), code: pasted.code, state: pasted.state, now: dependencies.clock() });
  if (!exchanged.ok) throw new Error(`the sign in could not be completed: ${exchanged.error}; run login without a code for a new url`);
  const id = accountIdOf(exchanged.label, exchanged.tokens);
  const isNew = findAccount(dependencies, id) === undefined;
  await storeTokens(dependencies, id, exchanged.tokens);
  try {
    return { id, label: id, outcome: upsertAccount(dependencies, id, exchanged.tokens) };
  } catch (cause) {
    if (isNew) await removeTokens(dependencies, id);
    throw cause;
  }
}

/**
 * The `login` action. With no `code` it answers the authorize url; with the pasted `code#state` it
 * exchanges it, keeps the tokens in the plugin's secrets and the account, without them, in the store.
 *
 * @remarks Each call may be its own process, so nothing is held between the two steps: the PKCE
 * verifier travels inside the `state` the url carries and comes back with the paste.
 */
export function createLoginAction(dependencies: AccountDependencies): (input: { code?: unknown }) => Promise<LoginAnswer> {
  return async (input) => {
    secretsOf(dependencies);
    const pasted = parsePastedCallback(typeof input.code === "string" ? input.code : undefined);
    if (pasted === undefined) {
      const url = authorizationUrl({ authorizeUrl: dependencies.settings().authorizeUrl, clientId: dependencies.clientId() });
      return { url, next: NEXT_STEP };
    }
    if (pasted.state === undefined) throw new Error("the pasted text carries no state; paste the whole code#state shown after signing in");
    return complete(dependencies, { code: pasted.code, state: pasted.state });
  };
}

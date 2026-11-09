import type { PluginSecrets } from "@weivel/typescript";

const PENDING_LOGIN_SECRET = "login.pending";
const NOT_IN_PROGRESS = "this code does not belong to the sign in in progress; run login without a code for a new url";

/** The sign in a url was issued for: its random `state`, and the PKCE verifier that must never leave this machine in it. */
export interface PendingLogin {
  state: string;
  verifier: string;
}

/**
 * Keeps the sign in in progress, replacing any earlier one.
 *
 * @implNote One slot rather than a secret per state: secrets cannot be listed, so a login abandoned
 * half way would leave a secret nothing could ever find to remove.
 */
export function rememberPendingLogin(secrets: PluginSecrets, pending: PendingLogin): Promise<void> {
  return secrets.set(PENDING_LOGIN_SECRET, JSON.stringify(pending));
}

/**
 * The verifier of the sign in `state` was issued for, consumed so a code cannot be replayed.
 *
 * @implNote A state that does not match leaves the slot alone, so a stray paste cannot cancel a sign in in progress.
 */
export async function claimVerifier(secrets: PluginSecrets, state: string): Promise<string> {
  const stored = await secrets.get(PENDING_LOGIN_SECRET);
  const pending = stored === undefined ? undefined : (JSON.parse(stored) as PendingLogin);
  if (pending === undefined || pending.state !== state) throw new Error(NOT_IN_PROGRESS);
  await secrets.delete(PENDING_LOGIN_SECRET);
  return pending.verifier;
}

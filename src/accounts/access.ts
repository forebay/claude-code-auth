import { refreshTokens } from "../oauth/refresh.js";
import { accessSecretName, findAccount, logIfRefused, refreshSecretName, secretsOf } from "./dependencies.js";
import type { AccountDependencies } from "./dependencies.js";

const DEFAULT_REFRESH_TIMEOUT_MILLISECONDS = 30000;
const RE_LOGIN_REQUIRED = "re-login required";

/** The access token of an account, or why none is usable. */
export type AccessAnswer = { access: string } | { none: true; reason: string };

export interface TokenAccess {
  /** The stored access token while it is valid, else a refreshed one. */
  ensureAccess(id: string, now: number, signal: AbortSignal): Promise<AccessAnswer>;
  /** A refreshed access token whether or not the stored one is still valid. */
  refreshNow(id: string, now: number, signal: AbortSignal): Promise<AccessAnswer>;
}

function unusable(reason: string): AccessAnswer {
  return { none: true, reason };
}

function report(dependencies: AccountDependencies, id: string, now: number, outcome: "disabled" | "error" | "success", reason?: string): void {
  const settings = dependencies.settings();
  try {
    const answer = dependencies.accounts().report({
      store: dependencies.store,
      id,
      outcome,
      ...(reason === undefined ? {} : { reason }),
      now,
      random: dependencies.random(),
      baseMilliseconds: settings.defaultCooldownSeconds * 1000,
      maxMilliseconds: settings.maxCooldownSeconds * 1000,
    });
    logIfRefused(dependencies, answer, `could not report ${outcome} for ${id}`);
  } catch (cause) {
    dependencies.log(`could not report ${outcome} for ${id}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

function hasCooldown(dependencies: AccountDependencies, id: string): boolean {
  const until = findAccount(dependencies, id)?.coolingDownUntil;
  return typeof until === "number" && until > 0;
}

/** @implNote The refresh token is written before the access token: a rotated one is already spent upstream, so losing it would lose the account. */
async function storeRefreshed(dependencies: AccountDependencies, id: string, previousRefresh: string, tokens: { access: string; refresh: string; expires: number }): Promise<void> {
  const secrets = secretsOf(dependencies);
  if (tokens.refresh !== previousRefresh) await secrets.set(refreshSecretName(id), tokens.refresh);
  await secrets.set(accessSecretName(id), tokens.access);
  logIfRefused(dependencies, dependencies.accounts().upsert({ store: dependencies.store, account: { id, expires: tokens.expires } }), `could not store the new expiry of ${id}`);
}

async function refreshed(dependencies: AccountDependencies, id: string, now: number): Promise<AccessAnswer> {
  const refreshToken = await secretsOf(dependencies).get(refreshSecretName(id));
  if (refreshToken === undefined) {
    report(dependencies, id, now, "disabled", `${RE_LOGIN_REQUIRED} (no refresh token is stored)`);
    return unusable(RE_LOGIN_REQUIRED);
  }
  const outcome = await refreshTokens({
    tokenUrl: dependencies.settings().tokenUrl,
    clientId: dependencies.clientId(),
    refreshToken,
    now,
    signal: AbortSignal.timeout(dependencies.refreshTimeoutMilliseconds ?? DEFAULT_REFRESH_TIMEOUT_MILLISECONDS),
  });
  if (!outcome.ok) {
    report(dependencies, id, now, outcome.revoked ? "disabled" : "error", outcome.revoked ? RE_LOGIN_REQUIRED : outcome.message);
    return unusable(outcome.revoked ? RE_LOGIN_REQUIRED : outcome.message);
  }
  await storeRefreshed(dependencies, id, refreshToken, outcome.tokens);
  if (hasCooldown(dependencies, id)) report(dependencies, id, now, "success");
  return { access: outcome.tokens.access };
}

function isExpired(dependencies: AccountDependencies, expires: number | null | undefined, now: number): boolean {
  return dependencies.accounts().tokenExpired({ ...(typeof expires === "number" ? { expires } : {}), now }).expired !== false;
}

/**
 * Builds the token access of the plugin.
 *
 * @remarks A revoked refresh token disables the account with the reason `re-login required`, so the
 * request path moves on to the next account instead of retrying. Any other failure, a timeout
 * included, cools the account down briefly, and a later good refresh clears that cooldown. Only the
 * caller's own abort rejects, and it reports nothing.
 *
 * @implNote Refreshes of one account share one in flight call: a rotated refresh token makes the
 * second of two concurrent refreshes with the old token fail as revoked, which would disable a
 * healthy account. The shared call has its own timeout, so one caller aborting does not cancel it.
 */
export function createTokenAccess(dependencies: AccountDependencies): TokenAccess {
  const inFlight = new Map<string, Promise<AccessAnswer>>();

  function refreshNow(id: string, now: number, signal: AbortSignal): Promise<AccessAnswer> {
    signal.throwIfAborted();
    const running = inFlight.get(id) ?? refreshed(dependencies, id, now).finally(() => inFlight.delete(id));
    inFlight.set(id, running);
    return running.then((answer) => {
      signal.throwIfAborted();
      return answer;
    });
  }

  async function ensureAccess(id: string, now: number, signal: AbortSignal): Promise<AccessAnswer> {
    signal.throwIfAborted();
    const account = findAccount(dependencies, id);
    if (account === undefined) return unusable(`no account ${id}`);
    if (account.enabled === false) return unusable(account.disabledReason ?? "disabled");
    const access = await secretsOf(dependencies).get(accessSecretName(id));
    if (access !== undefined && !isExpired(dependencies, account.expires, now)) return { access };
    return refreshNow(id, now, signal);
  }

  return { ensureAccess, refreshNow };
}

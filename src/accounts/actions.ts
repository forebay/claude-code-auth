import type { AccessAnswer, TokenAccess } from "./access.js";
import { accessSecretName, enabledAccounts, refreshSecretName, secretsOf, storedAccounts } from "./dependencies.js";
import type { AccountDependencies } from "./dependencies.js";
import { verifyAccess } from "./verify.js";
import type { VerifyAnswer } from "./verify.js";

/** What a row adds to an action's argument: the account it was run on. */
export interface RowInput {
  item?: unknown;
}

export interface ListedAccount {
  id: string;
  label?: string;
  enabled: boolean;
  disabledReason?: string;
  coolingDownUntil?: number;
  expires?: number;
}

const NEVER_ABORTED = new AbortController().signal;

function itemOf(input: RowInput): string | undefined {
  return typeof input.item === "string" && input.item !== "" ? input.item : undefined;
}

function targetIds(dependencies: AccountDependencies, input: RowInput): string[] {
  return itemOf(input) === undefined ? enabledAccounts(dependencies).map((account) => account.id) : [itemOf(input) as string];
}

/** The `accounts` action: each account and whether it is usable, never a token. */
export function listAccountsAction(dependencies: AccountDependencies): () => { accounts: ListedAccount[] } {
  return () => ({
    accounts: storedAccounts(dependencies).map((account) => ({
      id: account.id,
      ...(account.label === undefined ? {} : { label: account.label }),
      enabled: account.enabled !== false,
      ...(account.disabledReason === undefined || account.disabledReason === "" ? {} : { disabledReason: account.disabledReason }),
      ...(account.coolingDownUntil === undefined ? {} : { coolingDownUntil: account.coolingDownUntil }),
      ...(typeof account.expires === "number" ? { expires: account.expires } : {}),
    })),
  });
}

async function verifyOne(dependencies: AccountDependencies, access: TokenAccess, id: string): Promise<{ id: string } & VerifyAnswer> {
  const now = dependencies.clock();
  const answer: AccessAnswer = await access.ensureAccess(id, now, NEVER_ABORTED);
  if ("none" in answer) return { id, status: "failed", detail: answer.reason };
  const verdict = await verifyAccess(dependencies.settings().apiBase, answer.access);
  if (verdict.status === "disabled") dependencies.accounts().report({ store: dependencies.store, id, outcome: "disabled", reason: "re-login required (token lacks inference scope)", now });
  if (verdict.status === "expired") dependencies.accounts().upsert({ store: dependencies.store, account: { id, expires: now } });
  return { id, ...verdict };
}

/**
 * The `verify` action, on the row's account or on every enabled one: a 401 is reported as expired
 * and makes the next use refresh the token, a 403 disables the account.
 */
export function verifyAction(dependencies: AccountDependencies, access: TokenAccess): (input: RowInput) => Promise<{ results: Array<{ id: string } & VerifyAnswer> }> {
  return async (input) => {
    const results = [];
    for (const id of targetIds(dependencies, input)) results.push(await verifyOne(dependencies, access, id));
    return { results };
  };
}

/** The `refresh` action: forces a new access token for the row's account or for every enabled one. */
export function refreshAction(dependencies: AccountDependencies, access: TokenAccess): (input: RowInput) => Promise<{ results: Array<{ id: string; refreshed: boolean; reason?: string }> }> {
  return async (input) => {
    const results = [];
    for (const id of targetIds(dependencies, input)) {
      const answer = await access.refreshNow(id, dependencies.clock(), NEVER_ABORTED);
      results.push("none" in answer ? { id, refreshed: false, reason: answer.reason } : { id, refreshed: true });
    }
    return { results };
  };
}

/** The `remove` action: forgets the row's account and deletes its tokens. */
export function removeAction(dependencies: AccountDependencies): (input: RowInput) => Promise<{ id: string; removed: boolean }> {
  return async (input) => {
    const id = itemOf(input);
    if (id === undefined) throw new Error("remove needs an account; run it from an account's row");
    const secrets = secretsOf(dependencies);
    const removed = dependencies.accounts().remove({ store: dependencies.store, id }).removed === true;
    await secrets.delete(accessSecretName(id));
    await secrets.delete(refreshSecretName(id));
    return { id, removed };
  };
}

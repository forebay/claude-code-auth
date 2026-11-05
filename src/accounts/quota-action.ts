import { mergedPools } from "../request/capture-quota.js";
import { quotaBars, remainingFractions } from "../request/quota-headers.js";
import type { QuotaBar, StoredQuota } from "../request/quota-headers.js";
import { reportAttempt } from "../request/report.js";
import { refreshQuota } from "../request/usage.js";
import type { TokenAccess } from "./access.js";
import { targetIds } from "./actions.js";
import type { RowInput } from "./actions.js";
import { findAccount } from "./dependencies.js";
import type { AccountDependencies } from "./dependencies.js";

const NEVER_ABORTED = new AbortController().signal;

export interface QuotaResult {
  id: string;
  bars?: QuotaBar[];
  hasCapacity?: boolean;
  reason?: string;
}

async function quotaOf(dependencies: AccountDependencies, access: TokenAccess, id: string): Promise<QuotaResult> {
  const token = await access.ensureAccess(id, dependencies.clock(), NEVER_ABORTED);
  if ("none" in token) return { id, reason: token.reason };
  const refreshed = await refreshQuota(dependencies.settings().apiBase, token.access);
  const stored = findAccount(dependencies, id)?.quota as StoredQuota | undefined;
  const pools = refreshed.complete ? refreshed.pools : mergedPools(stored, refreshed.pools);
  if (Object.keys(pools).length === 0) return { id, reason: "the upstream reported no quota" };
  reportAttempt(dependencies, id, { outcome: "quota", quota: { pools, at: dependencies.clock() } });
  const quota: StoredQuota = { pools };
  return { id, bars: quotaBars(quota) ?? [], hasCapacity: dependencies.accounts().hasCapacity({ pools: remainingFractions(quota) }).capacity === true };
}

/**
 * The `quota` action: asks the upstream how full each pool of the row's account, or of every enabled
 * account, is, and keeps the answer in the account's quota. The usage endpoint replaces the stored
 * pools; the ping's headers only carry the pools relevant to that request, so they are merged.
 */
export function quotaAction(dependencies: AccountDependencies, access: TokenAccess): (input: RowInput) => Promise<{ results: QuotaResult[] }> {
  return async (input) => {
    const results: QuotaResult[] = [];
    for (const id of targetIds(dependencies, input)) {
      results.push(await quotaOf(dependencies, access, id).catch((cause: unknown) => ({ id, reason: cause instanceof Error ? cause.message : String(cause) })));
    }
    return { results };
  };
}

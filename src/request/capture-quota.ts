import { findAccount } from "../accounts/dependencies.js";
import type { AccountDependencies } from "../accounts/dependencies.js";
import { readPools } from "./quota-headers.js";
import type { QuotaPool, StoredQuota } from "./quota-headers.js";
import { reportAttempt } from "./report.js";

/** Pools a response's headers carry, merged over the stored ones. */
export function mergedPools(stored: StoredQuota | undefined, found: Record<string, QuotaPool>): Record<string, QuotaPool> {
  return { ...stored?.pools, ...found };
}

/**
 * Records what a response's headers say of the account's quota. The merge keeps the pools this
 * response did not mention: a model scoped weekly bucket only appears on requests to that model.
 */
export function captureQuota(dependencies: AccountDependencies, id: string, headers: Record<string, string>): void {
  const found = readPools(headers);
  if (Object.keys(found).length === 0) return;
  try {
    const stored = findAccount(dependencies, id)?.quota as StoredQuota | undefined;
    reportAttempt(dependencies, id, { outcome: "quota", quota: { pools: mergedPools(stored, found), at: dependencies.clock() } });
  } catch (cause) {
    dependencies.log(`could not capture the quota of ${id}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

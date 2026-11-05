import type { AccountOutcome } from "@forebay/host";
import { MESSAGES_LANE } from "../constants.js";
import { logIfRefused } from "../accounts/dependencies.js";
import type { AccountDependencies } from "../accounts/dependencies.js";
import type { QuotaPool } from "./quota-headers.js";

export interface AttemptReport {
  outcome: AccountOutcome;
  attempt?: number;
  reason?: string;
  resetAt?: number;
  quota?: { pools: Record<string, QuotaPool>; at: number };
}

/**
 * Reports what an attempt did to an account. A refusal or a failure of the accounts service is
 * logged and never stops the request: the answer to the caller does not depend on the bookkeeping.
 */
export function reportAttempt(dependencies: AccountDependencies, id: string, report: AttemptReport): void {
  const settings = dependencies.settings();
  const what = `could not report ${report.outcome} for ${id}`;
  try {
    const answer = dependencies.accounts().report({
      store: dependencies.store,
      id,
      lane: MESSAGES_LANE,
      now: dependencies.clock(),
      random: dependencies.random(),
      baseMilliseconds: settings.defaultCooldownSeconds * 1000,
      maxMilliseconds: settings.maxCooldownSeconds * 1000,
      ...report,
    });
    logIfRefused(dependencies, answer, what);
  } catch (cause) {
    dependencies.log(`${what}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

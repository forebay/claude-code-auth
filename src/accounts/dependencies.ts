import type { AccountsService, StoredAccount } from "@forebay/host";
import type { PluginSecrets } from "@weivel/typescript";
import type { ClaudeSettings } from "../settings.js";

/** What every account operation reaches outside itself for; each is a seam so a test decides it. */
export interface AccountDependencies {
  accounts: () => AccountsService;
  store: string;
  secrets: PluginSecrets | undefined;
  settings: () => ClaudeSettings;
  clientId: () => string;
  clock: () => number;
  random: () => number;
  log: (message: string) => void;
  /** How long a shared token refresh may take before it counts as a failed one. */
  refreshTimeoutMilliseconds?: number;
}

export function secretsOf(dependencies: AccountDependencies): PluginSecrets {
  if (dependencies.secrets === undefined) throw new Error("this host has no secret store, which claude-code-auth keeps its account tokens in");
  return dependencies.secrets;
}

/** What a service answer says when the service refused it, as `cause; fix`, else undefined. */
function refusalOf(answer: { refused?: string; fix?: string }): string | undefined {
  return answer.refused === undefined ? undefined : `${answer.refused}; ${answer.fix ?? "check the accounts store, then retry"}`;
}

/** Answers the answer, or throws when the accounts service refused it, naming `what` was attempted with the cause and fix. */
export function accepted<Answer extends { refused?: string; fix?: string }>(answer: Answer, what: string): Answer {
  const refusal = refusalOf(answer);
  if (refusal !== undefined) throw new Error(`${what}: ${refusal}`);
  return answer;
}

/** Logs a refusal of an effect that must not stop the caller. */
export function logIfRefused(dependencies: AccountDependencies, answer: { refused?: string; fix?: string }, what: string): void {
  const refusal = refusalOf(answer);
  if (refusal !== undefined) dependencies.log(`${what}: ${refusal}`);
}

export function storedAccounts(dependencies: AccountDependencies): StoredAccount[] {
  return accepted(dependencies.accounts().list({ store: dependencies.store }), "could not list the accounts").accounts ?? [];
}

export function findAccount(dependencies: AccountDependencies, id: string): StoredAccount | undefined {
  return storedAccounts(dependencies).find((account) => account.id === id);
}

export function enabledAccounts(dependencies: AccountDependencies): StoredAccount[] {
  return storedAccounts(dependencies).filter((account) => account.enabled !== false);
}

export function accessSecretName(id: string): string {
  return `account.${id}.access`;
}

export function refreshSecretName(id: string): string {
  return `account.${id}.refresh`;
}

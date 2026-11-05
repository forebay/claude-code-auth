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
}

export function secretsOf(dependencies: AccountDependencies): PluginSecrets {
  if (dependencies.secrets === undefined) throw new Error("this host has no secret store, which claude-code-auth keeps its account tokens in");
  return dependencies.secrets;
}

export function storedAccounts(dependencies: AccountDependencies): StoredAccount[] {
  return dependencies.accounts().list({ store: dependencies.store }).accounts ?? [];
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

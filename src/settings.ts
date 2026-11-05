import type { PluginConfig } from "@weivel/typescript";
import { CLAUDE_CLIENT_ID, CLIENT_ID_VARIABLE } from "./constants.js";

/**
 * What this plugin's configuration says, under names that read as code.
 *
 * @remarks The three URLs are settings so a test points them at a loopback fixture.
 *
 * @implNote `authorizeUrl` must stay on claude.ai: that host grants a subscription token with a real
 * `user:inference` entitlement, while platform.claude.com mints an API-key-mode token that
 * `/v1/messages` rejects with a 403. The host decides this, not the scope.
 */
export interface ClaudeSettings {
  authorizeUrl: string;
  tokenUrl: string;
  apiBase: string;
  accountSelectionStrategy: string;
  logging: boolean;
  maxAccountAttempts: number;
  defaultCooldownSeconds: number;
  maxCooldownSeconds: number;
}

function required<T>(config: PluginConfig, key: string, type: "string" | "number" | "boolean"): T {
  const value = config.get<unknown>(key);
  if (value === undefined) throw new Error(`the ${key} setting is missing from claude-code-auth's configuration`);
  if (typeof value !== type) throw new Error(`the ${key} setting of claude-code-auth must be a ${type}`);
  return value as T;
}

/** Reads every setting afresh, so a change made while the host runs applies to the next call. */
export function readSettings(config: PluginConfig): ClaudeSettings {
  return {
    authorizeUrl: required(config, "oauth_authorize_url", "string"),
    tokenUrl: required(config, "oauth_token_url", "string"),
    apiBase: required<string>(config, "api_base_url", "string").replace(/\/+$/, ""),
    accountSelectionStrategy: required(config, "account_selection_strategy", "string"),
    logging: required(config, "logging", "boolean"),
    maxAccountAttempts: required(config, "max_account_attempts", "number"),
    defaultCooldownSeconds: required(config, "default_cooldown_seconds", "number"),
    maxCooldownSeconds: required(config, "max_cooldown_seconds", "number"),
  };
}

/** The OAuth client id: the environment's override when it is set and not blank, else the public one. */
export function clientIdOf(environment: Record<string, string | undefined>): string {
  const override = environment[CLIENT_ID_VARIABLE]?.trim();
  return override === undefined || override === "" ? CLAUDE_CLIENT_ID : override;
}

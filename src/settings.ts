import type { PluginConfig } from "@weivel/typescript";
import { CLAUDE_CLIENT_ID, CLIENT_ID_VARIABLE } from "./constants.js";

const LOOPBACK_IPV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

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
  if (value === undefined) throw new Error(`the ${key} setting is missing from claude-code-provider's configuration`);
  if (typeof value !== type) throw new Error(`the ${key} setting of claude-code-provider must be a ${type}`);
  return value as T;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || LOOPBACK_IPV4.test(hostname);
}

function isSafeForTokens(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname));
  } catch {
    return false;
  }
}

function tokenBearingUrl(config: PluginConfig, key: string): string {
  const value = required<string>(config, key, "string");
  if (!isSafeForTokens(value)) throw new Error(`the ${key} setting of claude-code-provider must be an https url, or http on a loopback address, because account tokens are sent to it`);
  return value;
}

/** Reads every setting afresh, so a change made while the host runs applies to the next call. */
export function readSettings(config: PluginConfig): ClaudeSettings {
  return {
    authorizeUrl: required(config, "oauth_authorize_url", "string"),
    tokenUrl: tokenBearingUrl(config, "oauth_token_url"),
    apiBase: tokenBearingUrl(config, "api_base_url").replace(/\/+$/, ""),
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

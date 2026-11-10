import { describe, expect, it } from "vitest";
import type { PluginConfig } from "@weivel/typescript";
import { MANIFEST_DEFAULTS } from "../test/world.js";
import { clientIdOf, readSettings } from "./settings.js";

function configOf(values: Record<string, unknown>): PluginConfig {
  return { get: (key: string) => values[key], all: () => values } as unknown as PluginConfig;
}

describe("readSettings", () => {
  it("reads what the manifest declares, with the real upstream urls by default", () => {
    expect(readSettings(configOf(MANIFEST_DEFAULTS))).toEqual({
      authorizeUrl: "https://claude.ai/oauth/authorize",
      tokenUrl: "https://platform.claude.com/v1/oauth/token",
      apiBase: "https://api.anthropic.com",
      accountSelectionStrategy: "hybrid",
      logging: true,
      maxAccountAttempts: 4,
      defaultCooldownSeconds: 60,
      maxCooldownSeconds: 900,
    });
  });

  it("drops a trailing slash from the api base", () => {
    expect(readSettings(configOf({ ...MANIFEST_DEFAULTS, api_base_url: "http://127.0.0.1:1/" })).apiBase).toBe("http://127.0.0.1:1");
  });

  it("names a missing or mistyped setting", () => {
    expect(() => readSettings(configOf({ ...MANIFEST_DEFAULTS, oauth_token_url: undefined }))).toThrow(/oauth_token_url setting is missing/);
    expect(() => readSettings(configOf({ ...MANIFEST_DEFAULTS, logging: "yes" }))).toThrow(/logging setting of claude-code-provider must be a boolean/);
  });
});

describe.each(["oauth_token_url", "api_base_url"])("the %s setting, which receives account tokens", (key) => {
  it.each(["https://example.test/token", "http://localhost:1", "http://127.0.0.1:1", "http://127.9.9.9:1", "http://[::1]:1"])("accepts %s", (url) => {
    expect(() => readSettings(configOf({ ...MANIFEST_DEFAULTS, [key]: url }))).not.toThrow();
  });

  it.each(["http://example.test", "http://127.0.0.1.example.com", "http://localhost.example.com", "http://127.0.0.1@example.test", "ftp://127.0.0.1", "not a url"])("refuses %s", (url) => {
    expect(() => readSettings(configOf({ ...MANIFEST_DEFAULTS, [key]: url }))).toThrow(new RegExp(`${key} setting of claude-code-provider must be an https url`));
  });
});

describe("clientIdOf", () => {
  it("is the public client unless CLAUDE_CODE_CLIENT_ID overrides it", () => {
    expect(clientIdOf({})).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
    expect(clientIdOf({ CLAUDE_CODE_CLIENT_ID: "override" })).toBe("override");
  });

  it("ignores a blank override", () => {
    expect(clientIdOf({ CLAUDE_CODE_CLIENT_ID: "  " })).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  });
});

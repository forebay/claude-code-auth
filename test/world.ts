import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import type { AccountDependencies } from "../src/accounts/dependencies.js";
import { readSettings } from "../src/settings.js";
import { fakeSecrets } from "./fake-secrets.js";
import { startOauthServer } from "./fixtures/oauth-server.js";
import type { OauthServer } from "./fixtures/oauth-server.js";
import { openTestAccounts } from "./accounts-library.js";
import type { TestAccounts } from "./accounts-library.js";
import { loginCommandOf } from "../src/accounts/dependencies.js";

export const NOW = 1_700_000_000_000;
export const NEVER_ABORTED = new AbortController().signal;

const MANIFEST = JSON.parse(readFileSync(join(import.meta.dirname, "..", "plugin.json"), "utf8")) as { config: { defaults: Record<string, unknown> } };

/** The defaults `plugin.json` declares, under the keys the host's configuration answers them by. */
export const MANIFEST_DEFAULTS: Record<string, unknown> = MANIFEST.config.defaults;

/** The settings of a plugin whose three upstream urls point at `server`. */
export function settingsFor(server: OauthServer): Record<string, unknown> {
  return {
    ...MANIFEST_DEFAULTS,
    oauth_authorize_url: `${server.url}/oauth/authorize`,
    oauth_token_url: `${server.url}/v1/oauth/token`,
    api_base_url: server.url,
  };
}

export interface World {
  server: OauthServer;
  library: TestAccounts;
  secrets: ReturnType<typeof fakeSecrets>;
  settings: Record<string, unknown>;
  reports: string[];
  dependencies: AccountDependencies;
  /** Moves the dependencies' clock to `time`. */
  at(time: number): void;
}

/** A fresh loopback server, a real `accounts` service on a temp store and in memory secrets for each test. */
export function useWorld(): () => World {
  let current: World | undefined;
  beforeEach(async () => {
    const server = await startOauthServer();
    const library = openTestAccounts();
    const secrets = fakeSecrets();
    const settings = settingsFor(server);
    const reports: string[] = [];
    let time = NOW;
    current = {
      server,
      library,
      secrets,
      settings,
      reports,
      at: (value) => {
        time = value;
      },
      dependencies: {
        accounts: () => library.accounts,
        store: library.store,
        secrets,
        settings: () => readSettings({ get: (key: string) => settings[key], all: () => settings } as never),
        clientId: () => "client-under-test",
        clock: () => time,
        random: () => 0.5,
        loginCommand: loginCommandOf("claude-code-loader", "claude-code-provider"),
        log: (message) => reports.push(message),
      },
    };
  });
  afterEach(async () => {
    await current?.server.close();
    current?.library.close();
  });
  return () => current as World;
}

/** Adds an enabled account with a stored access and refresh token, expiring at `expires`. */
export async function seedAccount(world: World, id: string, expires: number): Promise<void> {
  world.library.accounts.upsert({ store: world.library.store, account: { id, label: id, enabled: true, expires } });
  await world.secrets.set(`account.${id}.access`, `stored-access-${id}`);
  await world.secrets.set(`account.${id}.refresh`, `stored-refresh-${id}`);
}

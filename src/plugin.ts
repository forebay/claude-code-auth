import { join } from "node:path";
import type { AccountsService, Provider } from "@forebay/host";
import type { Plugin, PluginContext } from "@weivel/typescript";
import { createTokenAccess } from "./accounts/access.js";
import { listAccountsAction, refreshAction, removeAction, verifyAction } from "./accounts/actions.js";
import type { AccountDependencies } from "./accounts/dependencies.js";
import { createLoginAction } from "./accounts/login.js";
import { quotaAction } from "./accounts/quota-action.js";
import { createProvider } from "./provider.js";
import { clientIdOf, readSettings } from "./settings.js";

const ACCOUNTS_STORE_FILE = "accounts.json";
const ACTIONS_SERVICE = "claude-code-auth:accounts";

function accountsOf(context: PluginContext): () => AccountsService {
  return () => {
    const accounts = context.services.get(context.service<AccountsService>("accounts"));
    if (accounts === undefined) throw new Error("this host offers no accounts service, so claude-code-auth cannot pick an account");
    return accounts;
  };
}

function dependenciesOf(context: PluginContext): AccountDependencies {
  return {
    accounts: accountsOf(context),
    store: join(context.paths.plugin, ACCOUNTS_STORE_FILE),
    secrets: context.secrets,
    settings: () => readSettings(context.config),
    clientId: () => clientIdOf(process.env),
    clock: Date.now,
    random: Math.random,
    log: (message) => context.log.warn(message),
  };
}

const plugin: Plugin = {
  activate(context) {
    const dependencies = dependenciesOf(context);
    const access = createTokenAccess(dependencies);
    context.provide(context.capability<Provider>("provider"), createProvider(dependencies, access));
    context.services.register(context.service(ACTIONS_SERVICE), {
      login: createLoginAction(dependencies),
      list: listAccountsAction(dependencies),
      verify: verifyAction(dependencies, access),
      refresh: refreshAction(dependencies, access),
      quota: quotaAction(dependencies, access),
      remove: removeAction(dependencies),
    });
  },
  deactivate() {},
};

export default plugin;

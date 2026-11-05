import type { HandleIrResult, ModelsAnswer, Provider } from "@forebay/host";
import type { TokenAccess } from "./accounts/access.js";
import { enabledAccounts } from "./accounts/dependencies.js";
import type { AccountDependencies } from "./accounts/dependencies.js";
import { fetchModels, NO_MODELS } from "./models.js";

const NOT_PORTED_STATUS = 501;

function notPorted(): HandleIrResult {
  return { status: NOT_PORTED_STATUS, headers: { "content-type": "text/plain" }, body: "claude-code-auth does not serve requests yet" };
}

/** The models of the first enabled account that has a usable access token, or none. */
async function listModels(dependencies: AccountDependencies, access: TokenAccess): Promise<ModelsAnswer> {
  for (const account of enabledAccounts(dependencies)) {
    const answer = await access.ensureAccess(account.id, dependencies.clock(), AbortSignal.timeout(30000));
    if (!("none" in answer)) return fetchModels(dependencies.settings().apiBase, answer.access);
  }
  return NO_MODELS;
}

export function createProvider(dependencies: AccountDependencies, access: TokenAccess): Provider {
  return {
    models: () => listModels(dependencies, access),
    handleIr: notPorted,
  };
}

import type { ModelsAnswer, Provider } from "@forebay/host";
import type { TokenAccess } from "./accounts/access.js";
import { enabledAccounts } from "./accounts/dependencies.js";
import type { AccountDependencies } from "./accounts/dependencies.js";
import { fetchModels, NO_MODELS } from "./models.js";
import { createHandleIr } from "./request/handle-ir.js";

const ACCESS_TIMEOUT_MILLISECONDS = 30000;

/** The models of the first enabled account that has a usable access token, or none. */
async function modelsOf(dependencies: AccountDependencies, access: TokenAccess, id: string): Promise<ModelsAnswer | undefined> {
  try {
    const answer = await access.ensureAccess(id, dependencies.clock(), AbortSignal.timeout(ACCESS_TIMEOUT_MILLISECONDS));
    return "none" in answer ? undefined : await fetchModels(dependencies.settings().apiBase, answer.access);
  } catch (cause) {
    dependencies.log(`could not list the models of ${id}: ${cause instanceof Error ? cause.message : String(cause)}`);
    return undefined;
  }
}

/**
 * The models of the first enabled account that has a usable access token, or none.
 *
 * @remarks Never rejects: an account that fails in any way is skipped, and no account at all is an empty list.
 */
async function listModels(dependencies: AccountDependencies, access: TokenAccess): Promise<ModelsAnswer> {
  try {
    for (const account of enabledAccounts(dependencies)) {
      const answer = await modelsOf(dependencies, access, account.id);
      if (answer !== undefined) return answer;
    }
  } catch (cause) {
    dependencies.log(`could not list the models: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
  return NO_MODELS;
}

export function createProvider(dependencies: AccountDependencies, access: TokenAccess): Provider {
  return {
    models: () => listModels(dependencies, access),
    handleIr: createHandleIr(dependencies, access),
  };
}

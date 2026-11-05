import type { ModelEntry, ModelsAnswer } from "@forebay/host";
import { ANTHROPIC_OAUTH_BETA, ANTHROPIC_VERSION } from "./constants.js";
import { objectMember, textMember } from "./oauth/token-set.js";

const MODELS_TIMEOUT_MILLISECONDS = 20000;
const MODEL_ID_PREFIX = "claude-";
const NAME_SUFFIX = " (Claude Code)";
const DEFAULT_CONTEXT_WINDOW = 200000;
const DEFAULT_OUTPUT_LIMIT = 64000;

export const NO_MODELS: ModelsAnswer = { models: [] };

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

/** @implNote The provider contract wants a context window and an output limit of at least 1, so a model the upstream gives no limits for gets the defaults. */
function entryOf(model: unknown): ModelEntry | undefined {
  const id = textMember(model, "id");
  if (id === undefined || !id.startsWith(MODEL_ID_PREFIX)) return undefined;
  return {
    id,
    name: `${textMember(model, "display_name") ?? id}${NAME_SUFFIX}`,
    context: positiveInteger(objectMember(model, "max_input_tokens"), DEFAULT_CONTEXT_WINDOW),
    output: positiveInteger(objectMember(model, "max_tokens"), DEFAULT_OUTPUT_LIMIT),
  };
}

function entriesOf(payload: unknown): ModelEntry[] {
  const data = objectMember(payload, "data");
  if (!Array.isArray(data)) return [];
  return data.map(entryOf).filter((entry): entry is ModelEntry => entry !== undefined);
}

/**
 * The models the upstream lists for an access token, only the `claude-` ones. Every failure, a
 * refusal, an unreachable upstream or a body that is not a list, answers no models rather than
 * throwing: a model list that cannot be fetched is an empty one, never a false one.
 */
export async function fetchModels(apiBase: string, access: string, signal: AbortSignal = AbortSignal.timeout(MODELS_TIMEOUT_MILLISECONDS)): Promise<ModelsAnswer> {
  try {
    const response = await fetch(`${apiBase}/v1/models?limit=1000`, {
      headers: { authorization: `Bearer ${access}`, "anthropic-version": ANTHROPIC_VERSION, "anthropic-beta": ANTHROPIC_OAUTH_BETA },
      signal,
    });
    if (!response.ok) return NO_MODELS;
    return { models: entriesOf(await response.json()) };
  } catch {
    return NO_MODELS;
  }
}

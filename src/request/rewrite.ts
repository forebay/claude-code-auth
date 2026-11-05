import type { IrBlock, IrRequest } from "@forebay/host";
import { anthropicTranslator } from "anthropic-translator";
import { ANTHROPIC_OAUTH_BETA, ANTHROPIC_VERSION, CLAUDE_CODE_SYSTEM } from "../constants.js";

const MESSAGES_PATH = "/v1/messages";

/** A request ready to send to the upstream, carrying the account's credentials. */
export interface RewrittenRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function isIdentity(block: IrBlock | undefined): boolean {
  return block?.kind === "text" && block.text === CLAUDE_CODE_SYSTEM;
}

/**
 * @implNote An empty `extensions` keeps the translator from writing a lone, plain text system block
 * back as a bare wire string, which the upstream does not accept as the identity.
 */
function identityBlock(): IrBlock {
  return { kind: "text", text: CLAUDE_CODE_SYSTEM, extensions: {} };
}

/** The system blocks led by the Claude Code identity block exactly once; a block already leading is kept as it is. */
export function withIdentityBlock(system: IrBlock[] | null | undefined): IrBlock[] {
  if (system == null || system.length === 0) return [identityBlock()];
  const [first] = system;
  if (!isIdentity(first)) return [identityBlock(), ...system];
  return system.length === 1 && first?.extensions == null ? [{ ...first, extensions: {} } as IrBlock] : system;
}

/** Puts a request onto the Anthropic API for a subscription token: the Bearer token, the version, the OAuth beta and the identity block. */
export function rewrite(request: IrRequest, access: string, apiBase: string): RewrittenRequest {
  const body = JSON.stringify(anthropicTranslator.encodeRequest({ ...request, system: withIdentityBlock(request.system) }));
  return {
    url: `${apiBase}${MESSAGES_PATH}`,
    headers: {
      authorization: `Bearer ${access}`,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": ANTHROPIC_OAUTH_BETA,
      "content-type": "application/json",
    },
    body,
  };
}

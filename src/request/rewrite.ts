import type { IrBlock, IrRequest } from "@forebay/host";
import { anthropicTranslator, WIRE_HEADERS_EXTENSION } from "anthropic-translator";
import { ANTHROPIC_OAUTH_BETA, ANTHROPIC_VERSION, CLAUDE_CODE_SYSTEM } from "../constants.js";

const MESSAGES_PATH = "/v1/messages";
const NOT_FORWARDED = ["x-api-key", "host", "content-length", "accept-encoding"];

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

/**
 * The `anthropic-beta` value with the OAuth flag added unless it is already there.
 *
 * @implNote The check is by substring, not by list membership, so `foo-oauth-2025-04-20-bar` counts as carrying the flag.
 */
export function mergeBeta(existing: string | undefined): string {
  if (existing === undefined || existing === "") return ANTHROPIC_OAUTH_BETA;
  return existing.includes(ANTHROPIC_OAUTH_BETA) ? existing : `${existing},${ANTHROPIC_OAUTH_BETA}`;
}

function clientHeaders(request: IrRequest): Record<string, string> {
  const carried = request.extensions?.[WIRE_HEADERS_EXTENSION];
  if (typeof carried !== "object" || carried === null) return {};
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(carried)) {
    const lowered = name.toLowerCase();
    if (typeof value === "string" && !NOT_FORWARDED.includes(lowered)) headers[lowered] = value;
  }
  return headers;
}

/**
 * Puts a request onto the Anthropic API for a subscription token: the client's own headers (a front door leaves them in
 * the `$wireHeaders` extension) with the Bearer token replacing its credentials, its `anthropic-version` kept else the
 * default, the OAuth beta merged in, and the identity system block.
 */
export function rewrite(request: IrRequest, access: string, apiBase: string): RewrittenRequest {
  const body = JSON.stringify(anthropicTranslator.encodeRequest({ ...request, system: withIdentityBlock(request.system) }));
  const client = clientHeaders(request);
  return {
    url: `${apiBase}${MESSAGES_PATH}`,
    headers: {
      ...client,
      authorization: `Bearer ${access}`,
      "anthropic-version": client["anthropic-version"] === undefined || client["anthropic-version"] === "" ? ANTHROPIC_VERSION : client["anthropic-version"],
      "anthropic-beta": mergeBeta(client["anthropic-beta"]),
      "content-type": "application/json",
    },
    body,
  };
}

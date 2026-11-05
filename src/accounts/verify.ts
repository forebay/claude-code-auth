import { ANTHROPIC_OAUTH_BETA, ANTHROPIC_VERSION, CLAUDE_CODE_SYSTEM } from "../constants.js";

const VERIFY_TIMEOUT_MILLISECONDS = 20000;
const VERIFY_MODEL = "claude-haiku-4-5";
const ANSWERS_THAT_VERIFY = [200, 400, 429];

export type VerifyStatus = "verified" | "expired" | "disabled" | "failed";

export interface VerifyAnswer {
  status: VerifyStatus;
  detail?: string;
}

function statusOf(httpStatus: number): VerifyAnswer {
  if (ANSWERS_THAT_VERIFY.includes(httpStatus)) return { status: "verified" };
  if (httpStatus === 401) return { status: "expired", detail: "token expired or revoked (401)" };
  if (httpStatus === 403) return { status: "disabled", detail: "the token lacks the inference scope (403)" };
  return { status: "failed", detail: `the upstream answered ${httpStatus}` };
}

/**
 * Sends a one token message to the upstream and reads what it says of the access token: a 200, a
 * 400 (the message itself was refused) and a 429 all prove the token is accepted.
 */
export async function verifyAccess(apiBase: string, access: string): Promise<VerifyAnswer> {
  try {
    const response = await fetch(`${apiBase}/v1/messages`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${access}`,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-beta": ANTHROPIC_OAUTH_BETA,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: VERIFY_MODEL, max_tokens: 1, system: [{ type: "text", text: CLAUDE_CODE_SYSTEM }], messages: [{ role: "user", content: "ping" }] }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MILLISECONDS),
    });
    return statusOf(response.status);
  } catch (cause) {
    return { status: "failed", detail: cause instanceof Error ? cause.message : String(cause) };
  }
}

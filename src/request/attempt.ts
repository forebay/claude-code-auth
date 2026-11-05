import type { RewrittenRequest } from "./rewrite.js";

/** What one attempt against the upstream produced: a response with its headers, or no response at all. */
export type Attempt = { kind: "response"; response: Response; headers: Record<string, string> } | { kind: "transport-failed" };

const RATE_LIMIT_STATUSES = [429, 529];

export function isRateLimitStatus(status: number): boolean {
  return RATE_LIMIT_STATUSES.includes(status);
}

export function headersOf(response: Response): Record<string, string> {
  return Object.fromEntries(response.headers.entries());
}

/**
 * Sends one request to the upstream under `signal`. A transport failure is an answer; a caller's
 * abort is not, and rejects so that nothing is reported for a request nobody is waiting on.
 */
export async function sendAttempt(request: RewrittenRequest, signal: AbortSignal): Promise<Attempt> {
  try {
    const response = await fetch(request.url, { method: "POST", headers: request.headers, body: request.body, signal });
    return { kind: "response", response, headers: headersOf(response) };
  } catch (cause) {
    if (signal.aborted) throw cause;
    return { kind: "transport-failed" };
  }
}

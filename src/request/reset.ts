const UNIFIED_RESET_HEADER = "anthropic-ratelimit-unified-reset";
const RETRY_AFTER_HEADER = "retry-after";

function positiveSeconds(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const seconds = Number(value);
  return Number.isNaN(seconds) || seconds <= 0 ? undefined : seconds;
}

function headerOf(headers: Record<string, string>, name: string): string | undefined {
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key === undefined ? undefined : headers[key];
}

/**
 * When a rate limit resets, in epoch milliseconds: the unified reset header (epoch seconds) first,
 * then `retry-after` (seconds from `now`), else undefined, which the caller turns into a backoff.
 */
export function parseResetMs(headers: Record<string, string>, now: number): number | undefined {
  const unified = positiveSeconds(headerOf(headers, UNIFIED_RESET_HEADER));
  if (unified !== undefined) return Math.trunc(unified * 1000);
  const retryAfter = positiveSeconds(headerOf(headers, RETRY_AFTER_HEADER));
  return retryAfter === undefined ? undefined : now + Math.trunc(retryAfter * 1000);
}

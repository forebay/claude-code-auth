const DEFAULT_LIFETIME_SECONDS = 3600;

/** The tokens a grant answered, with the epoch millisecond the access token stops being usable. */
export interface TokenSet {
  access?: string;
  refresh: string;
  expires: number;
}

/** The epoch millisecond a token issued at `now` expires; only a positive number overrides the one hour default. */
export function expiryOf(now: number, expiresInSeconds: unknown): number {
  const seconds = typeof expiresInSeconds === "number" && Number.isFinite(expiresInSeconds) && expiresInSeconds > 0 ? expiresInSeconds : DEFAULT_LIFETIME_SECONDS;
  return now + Math.round(seconds * 1000);
}

export function objectMember(source: unknown, name: string): unknown {
  return typeof source === "object" && source !== null ? (source as Record<string, unknown>)[name] : undefined;
}

/** A non-empty string member of `source`, or undefined. */
export function textMember(source: unknown, name: string): string | undefined {
  const value = objectMember(source, name);
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The JSON a response carried, or undefined when its body is not JSON. */
export async function jsonBodyOf(response: Response): Promise<unknown> {
  try {
    return JSON.parse(await response.text());
  } catch {
    return undefined;
  }
}

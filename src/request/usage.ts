import { ANTHROPIC_OAUTH_BETA, ANTHROPIC_VERSION, CLAUDE_CODE_SYSTEM } from "../constants.js";
import { objectMember, textMember } from "../oauth/token-set.js";
import { readPools } from "./quota-headers.js";
import type { QuotaPool } from "./quota-headers.js";

const USAGE_TIMEOUT_MILLISECONDS = 20000;
const PING_MODEL = "claude-haiku-4-5";
const PERCENT_DIVISOR = 100;

function scopeKeyOf(limit: unknown): string {
  const model = objectMember(objectMember(limit, "scope"), "model");
  const scope = textMember(model, "display_name") ?? textMember(model, "id");
  return scope === undefined ? "" : scope.toLowerCase().replace(/\s+/g, "-");
}

/**
 * The bucket one entry of the usage endpoint's `limits` belongs to: a session is `5h`, `weekly_all`
 * is `7d`, a weekly limit scoped to a model is `7d-<model>`, anything else is its kind or group,
 * suffixed with the model scope. Undefined when the entry names neither a kind nor a group.
 */
export function bucketOfLimit(limit: unknown): string | undefined {
  if (typeof limit !== "object" || limit === null) return undefined;
  const kind = textMember(limit, "kind");
  const group = textMember(limit, "group");
  const scopeKey = scopeKeyOf(limit);
  if (kind === "session") return "5h";
  if (kind === "weekly_all") return "7d";
  if (group === "weekly" && scopeKey !== "") return `7d-${scopeKey}`;
  const base = kind ?? group;
  if (base === undefined) return undefined;
  return scopeKey === "" ? base : `${base}-${scopeKey}`;
}

function poolOfLimit(limit: unknown, percent: number): QuotaPool {
  const pool: QuotaPool = { utilization: percent / PERCENT_DIVISOR };
  const reset = Date.parse(textMember(limit, "resets_at") ?? "");
  if (!Number.isNaN(reset)) pool.reset = reset;
  const status = textMember(limit, "severity");
  if (status !== undefined) pool.status = status;
  return pool;
}

/** The pools of a usage endpoint answer, or undefined when it is not a list of limits. */
export function poolsOfUsage(payload: unknown): Record<string, QuotaPool> | undefined {
  const limits = objectMember(payload, "limits");
  if (!Array.isArray(limits)) return undefined;
  const pools: Record<string, QuotaPool> = {};
  for (const limit of limits) {
    const bucket = bucketOfLimit(limit);
    const percent = objectMember(limit, "percent");
    if (bucket !== undefined && typeof percent === "number") pools[bucket] = poolOfLimit(limit, percent);
  }
  return pools;
}

function upstreamHeaders(access: string): Record<string, string> {
  return { authorization: `Bearer ${access}`, "anthropic-version": ANTHROPIC_VERSION, "anthropic-beta": ANTHROPIC_OAUTH_BETA };
}

async function fetchUsagePools(apiBase: string, access: string): Promise<Record<string, QuotaPool> | undefined> {
  const response = await fetch(`${apiBase}/api/oauth/usage`, { headers: upstreamHeaders(access), signal: AbortSignal.timeout(USAGE_TIMEOUT_MILLISECONDS) });
  if (!response.ok) return undefined;
  const pools = poolsOfUsage(await response.json());
  return pools === undefined || Object.keys(pools).length === 0 ? undefined : pools;
}

async function pingPools(apiBase: string, access: string): Promise<Record<string, QuotaPool>> {
  const response = await fetch(`${apiBase}/v1/messages`, {
    method: "POST",
    headers: { ...upstreamHeaders(access), "content-type": "application/json" },
    body: JSON.stringify({ model: PING_MODEL, max_tokens: 1, system: [{ type: "text", text: CLAUDE_CODE_SYSTEM }], messages: [{ role: "user", content: "ping" }] }),
    signal: AbortSignal.timeout(USAGE_TIMEOUT_MILLISECONDS),
  });
  return readPools(Object.fromEntries(response.headers.entries()));
}

/** What a quota refresh learned, and whether it is the whole picture (`complete`) or only what one response's headers carried. */
export interface QuotaRefresh {
  pools: Record<string, QuotaPool>;
  complete: boolean;
}

/**
 * Asks the usage endpoint, which lists every pool including model scoped weekly ones, and falls back
 * to a one token ping whose response headers carry the pools relevant to that request.
 */
export async function refreshQuota(apiBase: string, access: string): Promise<QuotaRefresh> {
  try {
    const pools = await fetchUsagePools(apiBase, access);
    if (pools !== undefined) return { pools, complete: true };
  } catch {
    // the usage endpoint failing only means the ping below has to answer
  }
  return { pools: await pingPools(apiBase, access), complete: false };
}

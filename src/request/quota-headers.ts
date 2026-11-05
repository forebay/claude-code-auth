/** One rate limit bucket as the upstream reports it: how full it is, when it resets (epoch ms) and its status. */
export interface QuotaPool {
  utilization?: number;
  reset?: number;
  status?: string;
}

export interface QuotaBar {
  label: string;
  remainingFraction: number;
  resetTime: number | null;
}

const UNIFIED_POOL_HEADER = /^anthropic-ratelimit-unified-(.+)-(utilization|reset|status)$/;
const BUCKET_LABEL = /^(\d+)([hd])(?:[-_](.+))?$/;
const MILLISECONDS_PER_SECOND = 1000;

function applyField(pool: QuotaPool, field: string, value: string): void {
  if (field === "utilization") {
    const utilization = Number.parseFloat(value);
    if (!Number.isNaN(utilization)) pool.utilization = utilization;
  } else if (field === "reset") {
    const seconds = Number.parseInt(value, 10);
    if (!Number.isNaN(seconds)) pool.reset = seconds * MILLISECONDS_PER_SECOND;
  } else if (value !== "") {
    pool.status = value;
  }
}

function isUsable(pool: QuotaPool): boolean {
  return pool.utilization !== undefined || pool.reset !== undefined;
}

/**
 * Discovers the rate limit pools in a response's headers, one per bucket (`5h`, `7d`, a per model
 * weekly bucket and any the upstream adds later), by the header names rather than a fixed list.
 * A pool with neither a number for its utilization nor for its reset is dropped.
 *
 * @implNote The bucketless `anthropic-ratelimit-unified-reset` header times the lane and has no pool
 * component for the pattern to capture, so it never matches.
 */
export function readPools(headers: Record<string, string>): Record<string, QuotaPool> {
  const pools: Record<string, QuotaPool> = {};
  for (const [name, value] of Object.entries(headers)) {
    const match = UNIFIED_POOL_HEADER.exec(name.toLowerCase());
    if (match === null) continue;
    const bucket = match[1] as string;
    applyField((pools[bucket] ??= {}), match[2] as string, value);
  }
  return Object.fromEntries(Object.entries(pools).filter(([, pool]) => isUsable(pool)));
}

function capitalized(text: string): string {
  return text === "" ? text : `${text[0]?.toUpperCase()}${text.slice(1)}`;
}

/** `5h` is `5-hour`, `7d` is `7-day`, `7d-fable` or `7d_fable` is `7-day (Fable)`, anything else stays as it is. */
export function poolLabel(bucket: string): string {
  const match = BUCKET_LABEL.exec(bucket);
  if (match === null) return bucket;
  const base = `${match[1]}${match[2] === "h" ? "-hour" : "-day"}`;
  return match[3] === undefined ? base : `${base} (${capitalized(match[3])})`;
}

/** The quota an account stores: the pools the upstream last reported, or the older `fiveHour` and `sevenDay` shape. */
export interface StoredQuota {
  pools?: Record<string, QuotaPool>;
  fiveHour?: QuotaPool;
  sevenDay?: QuotaPool;
  at?: number;
}

function remainingOf(pool: QuotaPool | undefined): number | undefined {
  return typeof pool?.utilization === "number" ? Math.max(0, Math.min(1, 1 - pool.utilization)) : undefined;
}

function barOf(pool: QuotaPool | undefined, label: string): QuotaBar[] {
  const remainingFraction = remainingOf(pool);
  return remainingFraction === undefined ? [] : [{ label, remainingFraction, resetTime: pool?.reset ?? null }];
}

/** Each pool as a labelled bar sorted by bucket, or undefined when there is nothing to show. */
export function quotaBars(quota: StoredQuota | undefined): QuotaBar[] | undefined {
  if (quota === undefined) return undefined;
  const bars = quota.pools === undefined
    ? [...barOf(quota.fiveHour, "5-hour"), ...barOf(quota.sevenDay, "7-day")]
    : Object.keys(quota.pools).sort().flatMap((bucket) => barOf(quota.pools?.[bucket], poolLabel(bucket)));
  return bars.length === 0 ? undefined : bars;
}

/** The remaining fraction of each pool that reports a utilization, for the `accounts` service's `hasCapacity`. */
export function remainingFractions(quota: StoredQuota | undefined): Array<{ remainingFraction: number }> {
  return Object.values(quota?.pools ?? {}).flatMap((pool) => {
    const remainingFraction = remainingOf(pool);
    return remainingFraction === undefined ? [] : [{ remainingFraction }];
  });
}

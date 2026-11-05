import type { Reply } from "./fixtures/oauth-server.js";

const JSON_TYPE = { "content-type": "application/json" };
const TEXT_TYPE = { "content-type": "text/plain;charset=UTF-8" };
const POOL_HEADERS = { "anthropic-ratelimit-unified-5h-utilization": "0.5", "anthropic-ratelimit-unified-5h-status": "allowed" };
const RESET_HEADERS = { "anthropic-ratelimit-unified-reset": "1700000100" };

export const MESSAGE = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  content: [{ type: "text", text: "hi" }],
  model: "claude-sonnet-4",
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

/** What the scripted account service acquires on one turn. */
export type Acquisition = null | "cooling" | { id: string; access: string };

/** One scenario of the parity oracle: the world it runs in, named exactly as the oracle names it. */
export interface Scenario {
  name: string;
  accounts: string[];
  acquire: Acquisition[];
  upstream: Reply[];
  /** The rate limit status of a scenario whose limits carry no reset, which now report an error to back off by. */
  headerless?: 429 | 529;
  /** Set where the old proxy pool shaped the oracle, which no longer exists: the calls this scenario makes now. */
  calls?: Array<Array<unknown>>;
}

const ok = (headers: Record<string, string> = {}): Reply => ({ status: 200, rawBody: JSON.stringify(MESSAGE), headers: { ...JSON_TYPE, ...headers } });
const answer = (status: number, headers: Record<string, string>, body: string): Reply => ({ status, rawBody: body, headers: { ...TEXT_TYPE, ...headers } });
const dropped: Reply = { status: 200, destroy: true };
const account = (id: string, access = `tok${id.replace("acc", "")}`): { id: string; access: string } => ({ id, access });

export const ATTEMPTS = 4;
const numbered = <Item>(count: number, make: (index: number) => Item): Item[] => Array.from({ length: count }, (_, index) => make(index));

export const SCENARIOS: Scenario[] = [
  { name: "happy path - 200 on attempt 0 (captureQuota mutate + reportSuccess + SERVE)", accounts: ["acc1"], acquire: [account("acc1")], upstream: [ok(POOL_HEADERS)] },
  { name: "happy path via proxy - reportResult(true) then SERVE", accounts: ["acc1"], acquire: [account("acc1")], upstream: [ok()] },
  { name: "429-then-ok via proxy - rotate + proxy reportRateLimit ipSuspected:true (has quota)", accounts: ["acc1", "acc2"], acquire: [account("acc1"), account("acc2")], upstream: [answer(429, RESET_HEADERS, "rate limited"), ok()] },
  { name: "429-then-ok via proxy - proxy reportRateLimit ipSuspected:false (no quota)", accounts: ["acc1", "acc2"], acquire: [account("acc1"), account("acc2")], upstream: [answer(429, RESET_HEADERS, "rate limited"), ok()] },
  { name: "429 with NO reset header then ok - exponential-backoff reset parity", accounts: ["acc1", "acc2"], acquire: [account("acc1"), account("acc2")], upstream: [answer(429, JSON_TYPE, "rate limited"), ok()], headerless: 429 },
  { name: "529 with NO reset header then ok - exponential-backoff reset parity", accounts: ["acc1", "acc2"], acquire: [account("acc1"), account("acc2")], upstream: [answer(529, JSON_TYPE, "overloaded"), ok()], headerless: 529 },
  { name: "two 429s with NO reset header then ok - doubling backoff parity", accounts: ["acc1", "acc2", "acc3"], acquire: [account("acc1"), account("acc2"), account("acc3")], upstream: [answer(429, JSON_TYPE, "rate limited"), answer(429, JSON_TYPE, "rate limited"), ok()], headerless: 429 },
  { name: "401 rotate then ok", accounts: ["acc1", "acc2"], acquire: [account("acc1"), account("acc2")], upstream: [answer(401, JSON_TYPE, "unauthorized"), ok()] },
  { name: "403 disable then ok", accounts: ["acc1", "acc2"], acquire: [account("acc1"), account("acc2")], upstream: [answer(403, JSON_TYPE, "forbidden"), ok()] },
  { name: "transport failure (no proxy) then ok - reportError message is the documented divergence", accounts: ["acc1", "acc2"], acquire: [account("acc1"), account("acc2")], upstream: [dropped, ok()] },
  { name: "transport failure via proxy → direct-retry succeeds - reportResult(false) then SERVE", accounts: ["acc1"], acquire: [account("acc1"), account("acc1")], upstream: [dropped, ok()], calls: [["manager.acquire", "messages", "acc1"], ["manager.reportError", "acc1", "messages", 0, "<transport-failed>"], ["manager.acquire", "messages", "acc1"], ["manager.reportSuccess", "acc1"]] },
  { name: "missing access token → reportError then rotate to ok", accounts: ["acc1", "acc2"], acquire: [account("acc1", ""), account("acc2")], upstream: [ok()] },
  { name: "no enabled account → terminal chatError 400", accounts: [], acquire: [null], upstream: [] },
  { name: "accounts only cooling down → retryable 503", accounts: ["acc1"], acquire: ["cooling"], upstream: [] },
  { name: "exhaustion - all 429, SERVE the last real upstream 429", accounts: [], acquire: numbered(ATTEMPTS, (i) => account(`acc${i}`)), upstream: numbered(ATTEMPTS, () => answer(429, RESET_HEADERS, "rate limited")) },
  { name: "exhaustion - all transport-fail, synthetic 502", accounts: [], acquire: numbered(ATTEMPTS, (i) => account(`acc${i}`)), upstream: numbered(ATTEMPTS, () => dropped) },
];

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startOauthServer } from "../../test/fixtures/oauth-server.js";
import type { OauthServer } from "../../test/fixtures/oauth-server.js";
import { loadVectors } from "../../test/vectors.js";
import { isRateLimitStatus, sendAttempt } from "./attempt.js";

let server: OauthServer;

beforeEach(async () => {
  server = await startOauthServer();
});

afterEach(async () => {
  await server.close();
});

const request = () => ({ url: `${server.url}/v1/messages`, headers: { "content-type": "application/json" }, body: "{}" });

describe("isRateLimitStatus against the Java vectors", () => {
  for (const vector of loadVectors<number, boolean>("status", "isRateLimitStatus")) {
    it(vector.name, () => {
      expect(isRateLimitStatus(vector.input)).toBe(vector.expected);
    });
  }
});

describe("sendAttempt", () => {
  it("answers the response with its headers lower cased", async () => {
    server.messagesResponder = () => ({ status: 429, body: {}, headers: { "Retry-After": "7", "content-type": "application/json" } });
    const attempt = await sendAttempt(request(), new AbortController().signal);
    expect(attempt.kind).toBe("response");
    expect(attempt.kind === "response" && attempt.headers["retry-after"]).toBe("7");
  });

  it("answers a transport failure when the connection is dropped", async () => {
    server.messagesResponder = () => ({ status: 200, destroy: true });
    expect(await sendAttempt(request(), new AbortController().signal)).toEqual({ kind: "transport-failed" });
  });

  it("rejects when the caller aborts, rather than answering a transport failure", async () => {
    server.messagesResponder = () => ({ status: 200, body: {}, delayMilliseconds: 500 });
    const aborter = new AbortController();
    const running = sendAttempt(request(), aborter.signal);
    aborter.abort(new Error("client went away"));
    await expect(running).rejects.toThrow();
  });
});

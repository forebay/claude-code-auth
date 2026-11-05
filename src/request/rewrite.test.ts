import { describe, expect, it } from "vitest";
import { anthropicTranslator } from "anthropic-translator";
import { loadVectors } from "../../test/vectors.js";
import { rewrite, withIdentityBlock } from "./rewrite.js";

const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const API_BASE = "http://upstream.test";

interface PrepareInput {
  body: string;
  access: string;
}

interface PrepareExpected {
  headers: Record<string, string>;
  bodyJson: unknown;
}

describe("rewrite against the Java vectors", () => {
  for (const vector of loadVectors<PrepareInput, PrepareExpected>("rewrite", "prepare")) {
    it(vector.name, () => {
      const request = anthropicTranslator.decodeRequest(JSON.parse(vector.input.body));
      const rewritten = rewrite(request, vector.input.access, API_BASE);
      expect(JSON.parse(rewritten.body)).toEqual(vector.expected.bodyJson);
      expect(rewritten.url).toBe(`${API_BASE}/v1/messages`);
      expect(rewritten.headers).toMatchObject({
        authorization: `Bearer ${vector.input.access}`,
        "anthropic-version": vector.expected.headers["anthropic-version"],
        "content-type": "application/json",
      });
    });
  }

  it("sends the oauth beta alone, since a request in the IR carries no headers of the client to merge", () => {
    const request = anthropicTranslator.decodeRequest({ model: "claude-x", messages: [] });
    expect(rewrite(request, "t", API_BASE).headers["anthropic-beta"]).toBe("oauth-2025-04-20");
  });
});

describe("withIdentityBlock", () => {
  it("leads a missing or empty system with the identity block", () => {
    for (const system of [undefined, null, []]) expect(withIdentityBlock(system)).toMatchObject([{ kind: "text", text: IDENTITY }]);
  });

  it("keeps a system that already leads with the identity as it is", () => {
    const system = [{ kind: "text" as const, text: IDENTITY }, { kind: "text" as const, text: "extra" }];
    expect(withIdentityBlock(system)).toBe(system);
  });

  it("keeps the cache control of a leading identity block", () => {
    const system = [{ kind: "text" as const, text: IDENTITY, cacheControl: "ephemeral" }];
    expect(withIdentityBlock(system)).toMatchObject([{ cacheControl: "ephemeral" }]);
  });

  it("prepends the identity once, in front of the original blocks", () => {
    const original = { kind: "text" as const, text: "custom" };
    const result = withIdentityBlock([original]);
    expect(result).toHaveLength(2);
    expect(result[1]).toBe(original);
  });

  it("never turns a lone identity string into a bare wire string", () => {
    const request = anthropicTranslator.decodeRequest({ model: "claude-x", system: IDENTITY, messages: [] });
    const body = JSON.parse(rewrite(request, "t", API_BASE).body) as { system: unknown };
    expect(body.system).toEqual([{ type: "text", text: IDENTITY }]);
  });
});

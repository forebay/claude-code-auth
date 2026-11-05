import { describe, expect, it } from "vitest";
import { anthropicTranslator, WIRE_HEADERS_EXTENSION } from "anthropic-translator";
import { loadVectors } from "../../test/vectors.js";
import { mergeBeta, rewrite, withIdentityBlock } from "./rewrite.js";

const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
const API_BASE = "http://upstream.test";

interface PrepareInput {
  body: string;
  headers: Record<string, string>;
  access: string;
}

interface PrepareExpected {
  headers: Record<string, string>;
  bodyJson: unknown;
}

function lowerCased(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

describe("rewrite against the Java vectors", () => {
  for (const vector of loadVectors<PrepareInput, PrepareExpected>("rewrite", "prepare")) {
    it(vector.name, () => {
      const decoded = anthropicTranslator.decodeRequest(JSON.parse(vector.input.body));
      const request = { ...decoded, extensions: { ...decoded.extensions, [WIRE_HEADERS_EXTENSION]: lowerCased(vector.input.headers) } };
      const rewritten = rewrite(request, vector.input.access, API_BASE);
      expect(JSON.parse(rewritten.body)).toEqual(vector.expected.bodyJson);
      expect(rewritten.url).toBe(`${API_BASE}/v1/messages`);
      expect(rewritten.headers).toEqual(vector.expected.headers);
    });
  }

  it("sends the oauth beta alone when the request carries no client headers", () => {
    const request = anthropicTranslator.decodeRequest({ model: "claude-x", messages: [] });
    expect(rewrite(request, "t", API_BASE).headers).toEqual({ authorization: "Bearer t", "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json" });
  });

  it("keeps the client headers out of the body", () => {
    const request = { ...anthropicTranslator.decodeRequest({ model: "claude-x", messages: [] }), extensions: { [WIRE_HEADERS_EXTENSION]: { "x-app": "cli" } } };
    expect(rewrite(request, "t", API_BASE).body).not.toContain("x-app");
  });
});

describe("mergeBeta against the Java vectors", () => {
  for (const vector of loadVectors<string | null, string>("rewrite", "mergeBeta")) {
    it(vector.name, () => {
      expect(mergeBeta(vector.input ?? undefined)).toBe(vector.expected);
    });
  }
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

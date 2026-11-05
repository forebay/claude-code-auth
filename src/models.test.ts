import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { contractProblems } from "../test/contract-answers.js";
import { startOauthServer } from "../test/fixtures/oauth-server.js";
import type { OauthServer } from "../test/fixtures/oauth-server.js";
import { loadVectors } from "../test/vectors.js";
import { fetchModels } from "./models.js";

let server: OauthServer;

beforeEach(async () => {
  server = await startOauthServer();
});

afterEach(async () => {
  await server.close();
});

describe("fetchModels", () => {
  it("maps the claude models with the oauth headers and never an api key", async () => {
    server.modelsResponder = () => ({
      status: 200,
      body: { data: [{ id: "claude-sonnet-4", display_name: "Claude Sonnet 4" }, { id: "gpt-4", display_name: "GPT-4" }, { id: "claude-bare" }, { display_name: "no id" }, null] },
    });
    const answer = await fetchModels(server.url, "the-access");
    expect(answer.models.map((model) => [model.id, model.name])).toEqual([
      ["claude-sonnet-4", "Claude Sonnet 4 (Claude Code)"],
      ["claude-bare", "claude-bare (Claude Code)"],
    ]);
    const [request] = server.requestsTo("/v1/models");
    expect(request?.method).toBe("GET");
    expect(request?.headers).toMatchObject({ authorization: "Bearer the-access", "anthropic-version": "2023-06-01" });
    expect(String(request?.headers["anthropic-beta"])).toContain("oauth-2025-04-20");
    expect(request?.headers["x-api-key"]).toBeUndefined();
  });

  it("asks for up to a thousand models", async () => {
    await fetchModels(server.url, "a");
    expect(server.requestsTo("/v1/models").map((request) => request.query)).toEqual(["?limit=1000"]);
  });

  it("answers entries the provider contract accepts, taking limits from the upstream when it gives them", async () => {
    server.modelsResponder = () => ({ status: 200, body: { data: [{ id: "claude-a", max_input_tokens: 1_000_000, max_tokens: 128_000 }, { id: "claude-b", max_tokens: 0 }] } });
    const answer = await fetchModels(server.url, "a");
    expect(contractProblems("ModelsAnswer", answer)).toEqual([]);
    expect(answer.models.map((model) => [model.context, model.output])).toEqual([[1_000_000, 128_000], [200_000, 64_000]]);
  });

  it("answers no models, never a throw, when the upstream refuses", async () => {
    server.modelsResponder = () => ({ status: 401, body: { type: "error" } });
    expect(await fetchModels(server.url, "a")).toEqual({ models: [] });
  });

  it("answers no models for a body that is not a list, or not JSON", async () => {
    server.modelsResponder = () => ({ status: 200, body: { data: "nope" } });
    expect(await fetchModels(server.url, "a")).toEqual({ models: [] });
    server.modelsResponder = () => ({ status: 200, rawBody: "<html>" });
    expect(await fetchModels(server.url, "a")).toEqual({ models: [] });
  });

  it("answers no models when the upstream cannot be reached", async () => {
    const unreachable = server.url;
    await server.close();
    expect(await fetchModels(unreachable, "a")).toEqual({ models: [] });
    server = await startOauthServer();
  });
});
describe("fetchModels against the Java vectors of the model mapping", () => {
  for (const vector of loadVectors<string | null, string | null>("models", "fetchModelsMapping")) {
    it(vector.name, async () => {
      server.modelsResponder = () => ({ status: 200, rawBody: vector.input ?? "" });
      const answer = await fetchModels(server.url, "a");
      const wanted = vector.expected === null ? {} : (JSON.parse(vector.expected) as { models: Record<string, { name: string }> }).models;
      expect(Object.fromEntries(answer.models.map((model) => [model.id, { name: model.name }]))).toEqual(wanted);
    });
  }
});

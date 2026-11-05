import { describe, expect, it } from "vitest";
import { loadVectors } from "../../test/vectors.js";
import { parseResetMs } from "./reset.js";

describe("parseResetMs against the Java vectors", () => {
  for (const vector of loadVectors<{ headers: Record<string, string>; now: number }, number | null>("reset", "parseResetMs")) {
    it(vector.name, () => {
      expect(parseResetMs(vector.input.headers, vector.input.now) ?? null).toBe(vector.expected);
    });
  }
});

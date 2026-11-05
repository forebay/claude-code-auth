import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createPkce } from "./pkce.js";

const FIXED_BYTES = Buffer.alloc(64, 7);

describe("createPkce", () => {
  it("makes the verifier base64url of 64 random bytes, unpadded", () => {
    const { verifier } = createPkce(() => FIXED_BYTES);
    expect(verifier).toBe(FIXED_BYTES.toString("base64url"));
    expect(verifier).toHaveLength(86);
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("hashes the verifier text, not the bytes behind it, for the S256 challenge", () => {
    const { verifier, challenge } = createPkce(() => FIXED_BYTES);
    expect(challenge).toBe(createHash("sha256").update(Buffer.from(verifier, "utf8")).digest("base64url"));
    expect(challenge).not.toBe(createHash("sha256").update(FIXED_BYTES).digest("base64url"));
  });

  it("asks for 64 bytes and differs between two real draws", () => {
    let asked = 0;
    createPkce((size) => {
      asked = size;
      return FIXED_BYTES;
    });
    expect(asked).toBe(64);
    expect(createPkce().verifier).not.toBe(createPkce().verifier);
  });
});

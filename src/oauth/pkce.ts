import { createHash, randomBytes } from "node:crypto";

const VERIFIER_BYTES = 64;

export interface Pkce {
  verifier: string;
  challenge: string;
}

/**
 * A PKCE pair for the S256 method: the verifier is base64url of 64 random bytes, the challenge is
 * base64url of the SHA-256 of the verifier's UTF-8 text.
 *
 * @implNote The challenge hashes the verifier STRING, not the random bytes behind it, which is what
 * the token endpoint verifies against.
 */
export function createPkce(entropy: (size: number) => Buffer = randomBytes): Pkce {
  const verifier = entropy(VERIFIER_BYTES).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
  return { verifier, challenge };
}

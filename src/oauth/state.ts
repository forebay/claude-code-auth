const MISSING_VERIFIER = "Missing PKCE verifier in state";

/** Packs the PKCE verifier into an OAuth `state` as unpadded URL-safe base64 of `{"verifier": ...}`. */
export function encodeState(verifier: string): string {
  return Buffer.from(JSON.stringify({ verifier }), "utf8").toString("base64url");
}

function payloadOf(state: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(state, "base64url").toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** The verifier `encodeState` packed, refusing a state that carries no string verifier. */
export function decodeVerifier(state: string): string {
  const verifier = payloadOf(state)?.verifier;
  if (typeof verifier !== "string" || verifier === "") throw new Error(MISSING_VERIFIER);
  return verifier;
}

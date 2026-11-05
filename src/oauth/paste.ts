export interface PastedCallback {
  code: string;
  state?: string;
}

const CODE_PARAMETER = /[?&]code=([^&\s]+)/;
const STATE_PARAMETER = /[?&]state=([^&\s]+)/;
const ESCAPE_RUN = /(?:%[0-9A-Fa-f]{2})+/g;

/** Percent-decodes runs of escapes as UTF-8, leaving a `+` as it is and a stray `%` as a literal. */
export function percentDecode(text: string): string {
  return text.replace(ESCAPE_RUN, (run) => Buffer.from(run.replace(/%/g, ""), "hex").toString("utf8"));
}

function fromUrl(text: string): PastedCallback | undefined {
  const code = CODE_PARAMETER.exec(text);
  if (code === null) return undefined;
  const state = STATE_PARAMETER.exec(text);
  return { code: percentDecode(code[1] as string), ...(state === null ? {} : { state: percentDecode(state[1] as string) }) };
}

function fromHashPair(text: string): PastedCallback | undefined {
  const hash = text.indexOf("#");
  if (hash < 0) return undefined;
  const state = (text.slice(hash + 1).split("#")[0] as string).trim();
  return { code: text.slice(0, hash).trim(), ...(state === "" ? {} : { state }) };
}

/**
 * Reads what a user pasted back: a full redirect URL, a `code#state` pair, or a bare code.
 * Answers undefined when nothing was pasted.
 */
export function parsePastedCallback(input: string | undefined): PastedCallback | undefined {
  const text = (input ?? "").trim();
  if (text === "") return undefined;
  return fromUrl(text) ?? fromHashPair(text) ?? { code: text };
}

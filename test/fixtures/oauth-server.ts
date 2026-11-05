import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface Reply {
  status: number;
  body?: unknown;
  rawBody?: string;
  delayMilliseconds?: number;
}

export type Responder = (request: RecordedRequest) => Reply;

/** A loopback stand-in for the OAuth token endpoint and the Anthropic API, recording what it is sent. */
export interface OauthServer {
  url: string;
  requests: RecordedRequest[];
  tokenResponder: Responder;
  modelsResponder: Responder;
  messagesResponder: Responder;
  requestsTo(path: string): RecordedRequest[];
  close(): Promise<void>;
}

export const GRANTED_TOKENS = {
  access_token: "access-from-grant",
  refresh_token: "refresh-from-grant",
  expires_in: 3600,
  account: { email_address: "me@example.com" },
};

function formParameters(body: string): URLSearchParams {
  return new URLSearchParams(body);
}

function grantTypeOf(request: RecordedRequest): string | null {
  const contentType = String(request.headers["content-type"] ?? "");
  if (contentType.includes("json")) return (JSON.parse(request.body) as { grant_type?: string }).grant_type ?? null;
  return formParameters(request.body).get("grant_type");
}

/** Answers the authorization code grant with {@link GRANTED_TOKENS} and a refresh with a new access token only. */
export function successfulGrants(request: RecordedRequest): Reply {
  return grantTypeOf(request) === "refresh_token" ? { status: 200, body: { access_token: "access-from-refresh", expires_in: 3600 } } : { status: 200, body: GRANTED_TOKENS };
}

const NO_MODELS_REPLY: Reply = { status: 200, body: { data: [] } };
const ACCEPTED_MESSAGE: Reply = { status: 200, body: { type: "message" } };

async function bodyOf(incoming: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of incoming) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function respond(outgoing: ServerResponse, reply: Reply): void {
  const text = reply.rawBody ?? JSON.stringify(reply.body ?? {});
  outgoing.writeHead(reply.status, { "content-type": "application/json" });
  outgoing.end(text);
}

function responderFor(server: OauthServer, path: string): Responder {
  if (path === "/v1/oauth/token") return server.tokenResponder;
  if (path === "/v1/models") return server.modelsResponder;
  if (path === "/v1/messages") return server.messagesResponder;
  return () => ({ status: 404 });
}

export async function startOauthServer(): Promise<OauthServer> {
  const requests: RecordedRequest[] = [];
  const state: OauthServer = {
    url: "",
    requests,
    tokenResponder: successfulGrants,
    modelsResponder: () => NO_MODELS_REPLY,
    messagesResponder: () => ACCEPTED_MESSAGE,
    requestsTo: (path) => requests.filter((request) => request.path === path),
    close: () => Promise.resolve(),
  };
  const listener: Server = createServer(async (incoming, outgoing) => {
    const target = new URL(incoming.url ?? "/", "http://loopback");
    const recorded: RecordedRequest = { method: incoming.method ?? "GET", path: target.pathname, query: target.search, headers: incoming.headers, body: await bodyOf(incoming) };
    requests.push(recorded);
    const reply = responderFor(state, target.pathname)(recorded);
    if (reply.delayMilliseconds !== undefined) await new Promise((resolve) => setTimeout(resolve, reply.delayMilliseconds));
    respond(outgoing, reply);
  });
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  state.url = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  state.close = () =>
    new Promise<void>((resolve) => {
      listener.closeAllConnections();
      listener.close(() => resolve());
    });
  return state;
}

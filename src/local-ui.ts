import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";

export type LocalUiCommand = "retry" | "approve" | "integrate" | "rollback" | "cancel" | "activate_patch";

export interface LocalUiCommandRequest {
  command: LocalUiCommand;
  arguments: Record<string, unknown>;
}

export interface LocalControlServerOptions {
  host?: string;
  publicHost?: string;
  port?: number;
  tls?: { cert: string | Buffer; key: string | Buffer };
  readModel(): Promise<unknown>;
  preview?(request: LocalUiCommandRequest): Promise<unknown>;
  command(request: LocalUiCommandRequest): Promise<unknown>;
}

export interface LocalControlServer {
  origin: string;
  launchUrl: string;
  session: string;
  csrf: string;
  close(): Promise<void>;
}

interface Preview {
  request: LocalUiCommandRequest;
  expiresAt: number;
}

const allowedCommands = new Set<LocalUiCommand>(["retry", "approve", "integrate", "rollback", "cancel", "activate_patch"]);
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);

export async function startLocalControlServer(options: LocalControlServerOptions): Promise<LocalControlServer> {
  const host = options.host ?? "127.0.0.1";
  if (!loopbackHosts.has(host) && !options.tls) throw new Error("non-loopback UI requires operator-supplied TLS certificate and key");
  const wildcard = host === "0.0.0.0" || host === "::";
  const publicHost = options.publicHost ?? host;
  if (wildcard && (!options.publicHost || options.publicHost === host)) throw new Error("wildcard UI binding requires an explicit publicHost for strict Host and Origin validation");
  if (/[/\\@]/.test(publicHost)) throw new Error("publicHost must be a hostname or IP address without a scheme or port");
  const session = randomBytes(32).toString("base64url");
  const csrf = randomBytes(32).toString("base64url");
  const previews = new Map<string, Preview>();
  let expectedHost = "";
  let origin = "";
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer");
      if (request.headers.host !== expectedHost) return send(response, 403, { error: "host rejected" });
      if (request.method === "OPTIONS") return send(response, 403, { error: "cross-origin preflight rejected" });
      const requestOrigin = request.headers.origin;
      if (requestOrigin !== undefined && requestOrigin !== origin) return send(response, 403, { error: "origin rejected" });
      const url = new URL(request.url ?? "/", origin);
      if (url.pathname === "/" && request.method === "GET") return html(response, shellHtml());
      if (url.pathname === "/app.js" && request.method === "GET") return javascript(response, clientScript());
      if (url.pathname === "/app.css" && request.method === "GET") return stylesheet(response, clientStyles());
      if (request.headers["x-agr-session"] !== session) return send(response, 401, { error: "session required" });
      if (url.pathname === "/api/session" && request.method === "GET") return send(response, 200, { csrf });
      if (url.pathname === "/api/status" && request.method === "GET") return send(response, 200, await options.readModel());
      if (url.pathname === "/api/events" && request.method === "GET") {
        response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
        response.end(`event: state\ndata: ${JSON.stringify(await options.readModel())}\n\n`);
        return;
      }
      if (request.method === "POST" && request.headers["x-agr-csrf"] !== csrf) return send(response, 403, { error: "csrf rejected" });
      if (url.pathname === "/api/command/preview" && request.method === "POST") {
        const body = await readJson(request);
        const command = body.command;
        if (typeof command !== "string" || !allowedCommands.has(command as LocalUiCommand) || !isRecord(body.arguments)) {
          return send(response, 400, { error: "invalid command preview" });
        }
        const previewId = randomUUID();
        const preview: Preview = {
          request: { command: command as LocalUiCommand, arguments: body.arguments },
          expiresAt: Date.now() + 5 * 60_000,
        };
        const details = await options.preview?.(preview.request);
        previews.set(previewId, preview);
        return send(response, 200, {
          previewId,
          command: preview.request.command,
          consequences: commandConsequence(preview.request.command),
          ...(details === undefined ? {} : { details }),
          expiresAt: new Date(preview.expiresAt).toISOString(),
        });
      }
      if (url.pathname === "/api/command/execute" && request.method === "POST") {
        const body = await readJson(request);
        const previewId = typeof body.previewId === "string" ? body.previewId : "";
        const preview = previews.get(previewId);
        if (!preview || preview.expiresAt < Date.now()) {
          previews.delete(previewId);
          return send(response, 409, { error: "preview is missing, expired, or already consumed" });
        }
        previews.delete(previewId);
        return send(response, 200, await options.command(preview.request));
      }
      send(response, 404, { error: "not found" });
    } catch (error) {
      send(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  };
  const server: Server = options.tls
    ? createSecureServer({ cert: options.tls.cert, key: options.tls.key }, (request, response) => void handler(request, response))
    : createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("UI server did not expose a TCP address");
  const displayHost = publicHost.includes(":") ? `[${publicHost}]` : publicHost;
  expectedHost = `${displayHost}:${address.port}`;
  origin = `${options.tls ? "https" : "http"}://${expectedHost}`;
  return {
    origin,
    launchUrl: `${origin}/#session=${session}`,
    session,
    csrf,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function commandConsequence(command: LocalUiCommand): string {
  return ({
    retry: "invalidates descendants and creates a new attempt",
    approve: "issues one exact single-use approval receipt",
    integrate: "changes the selected local Git branch",
    rollback: "creates a Git revert commit",
    cancel: "requests cooperative cancellation",
    activate_patch: "changes the plan for the next wave",
  })[command];
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 64 * 1024) throw new Error("request body too large");
    chunks.push(bytes);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!isRecord(parsed)) throw new Error("JSON object required");
  return parsed;
}

function send(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value)}\n`);
}

function html(response: ServerResponse, value: string): void {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(value);
}

function javascript(response: ServerResponse, value: string): void {
  response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
  response.end(value);
}

function stylesheet(response: ServerResponse, value: string): void {
  response.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
  response.end(value);
}

function shellHtml(): string {
  return "<!doctype html><html><head><meta charset=utf-8><meta name=viewport content=\"width=device-width,initial-scale=1\"><title>Agent Graph Runtime</title><link rel=stylesheet href=/app.css></head><body><main><h1>Agent Graph Runtime</h1><p id=status>Connecting to local coordinator…</p><button id=refresh type=button>Refresh run state</button><pre id=state aria-live=polite></pre><section class=actions><h2>Operator command</h2><label>Command <select id=command><option>retry</option><option>approve</option><option>integrate</option><option>rollback</option><option>cancel</option><option>activate_patch</option></select></label><label>Arguments as JSON<textarea id=arguments spellcheck=false>{}</textarea></label><button id=preview type=button>Preview command</button><p id=consequence class=danger aria-live=polite></p><button id=execute type=button disabled>Execute reviewed preview</button><pre id=result aria-live=polite></pre></section></main><script src=/app.js></script></body></html>";
}

function clientStyles(): string {
  return "body{font:16px system-ui;max-width:72rem;margin:auto;padding:2rem;background:#101418;color:#eef}button,select,textarea{font:inherit;margin:.25rem;padding:.55rem}textarea{width:100%;min-height:7rem}pre{white-space:pre-wrap;background:#192129;padding:1rem;border-radius:.5rem}.actions{display:grid;gap:.5rem;max-width:48rem}.danger{color:#ffc6c6}";
}

function clientScript(): string {
  return "const q=s=>document.querySelector(s);const session=new URLSearchParams(location.hash.slice(1)).get('session');history.replaceState(null,'',location.pathname);const headers={'x-agr-session':session||''};let csrf='',previewId='';async function json(url,options={}){const r=await fetch(url,{...options,headers:{...headers,...(options.headers||{})}});const b=await r.json();if(!r.ok)throw new Error(b.error||('Request failed '+r.status));return b}async function refresh(){const s=await json('/api/status');q('#status').textContent=s.status||'ready';q('#state').textContent=JSON.stringify(s,null,2)}async function start(){csrf=(await json('/api/session')).csrf;await refresh()}q('#refresh').onclick=()=>refresh().catch(show);q('#preview').onclick=async()=>{try{const argumentsValue=JSON.parse(q('#arguments').value);const p=await json('/api/command/preview',{method:'POST',headers:{'content-type':'application/json','x-agr-csrf':csrf},body:JSON.stringify({command:q('#command').value,arguments:argumentsValue})});previewId=p.previewId;q('#consequence').textContent=p.consequences+'; preview expires '+p.expiresAt+(p.details?'\n'+JSON.stringify(p.details,null,2):'');q('#execute').disabled=false}catch(e){show(e)}};q('#execute').onclick=async()=>{try{q('#execute').disabled=true;const r=await json('/api/command/execute',{method:'POST',headers:{'content-type':'application/json','x-agr-csrf':csrf},body:JSON.stringify({previewId})});previewId='';q('#result').textContent=JSON.stringify(r,null,2);await refresh()}catch(e){show(e)}};function show(e){q('#status').textContent=e.message||String(e)}start().catch(show);";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

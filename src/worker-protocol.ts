import { randomUUID, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { sha256 } from "./persistence.js";
import type { RemoteAttemptEnvelope, WorkerCapabilities, WorkerLease } from "./sqlite-coordinator.js";
import { repositoryHead, repositorySnapshotHash } from "./repository-snapshot.js";
import type { ModelUsageEvidence } from "./types.js";

export interface WorkerPayload {
  executor: string;
  prompt: string;
  repositorySnapshot?: { commit: string; bundleBase64?: string };
}

export interface WorkerDispatchRequest {
  envelope: RemoteAttemptEnvelope;
  lease: WorkerLease;
  payload: WorkerPayload;
}

export interface WorkerExecutionResult {
  status: "complete" | "partial" | "blocked";
  summary: string;
  changedFiles: string[];
  artifacts: Array<{ name: string; type: string; path: string }>;
  modelUsage?: Record<string, ModelUsageEvidence>;
}

export interface WorkerResultEnvelope {
  schemaVersion: 1;
  resultId: string;
  attemptId: string;
  workerId: string;
  fencingToken: number;
  status: WorkerExecutionResult["status"];
  summary: string;
  patch: { files: Array<{ path: string; sha256: string; size: number; contentBase64: string }> };
  artifacts: WorkerExecutionResult["artifacts"];
  modelUsage?: Record<string, ModelUsageEvidence>;
  completedAt: number;
  resultHash: string;
}

export interface WorkerServerOptions {
  host?: string;
  port?: number;
  coordinatorToken: string;
  workerId: string;
  capabilities: WorkerCapabilities;
  workspace: string;
  tls?: { cert: string | Buffer; key: string | Buffer };
  execute(request: WorkerDispatchRequest, attemptWorkspace: string): Promise<WorkerExecutionResult>;
}

const exec = promisify(execFile);

export async function startWorkerServer(options: WorkerServerOptions): Promise<{ origin: string; close(): Promise<void> }> {
  const host = options.host ?? "127.0.0.1";
  if (!new Set(["127.0.0.1", "localhost", "::1"]).has(host) && !options.tls) throw new Error("worker LAN transport requires TLS");
  if (options.coordinatorToken.length < 6) throw new Error("coordinator token is too short");
  let active = 0;
  const listener = (request: IncomingMessage, response: ServerResponse): void => void (async () => {
    try {
      response.setHeader("Cache-Control", "no-store");
      const pathname = new URL(request.url ?? "/", "http://worker.invalid").pathname;
      if (!["/v1/health", "/v1/attempt"].includes(pathname)) return send(response, 404, { error: "not found" });
      if (!authorized(request, options.coordinatorToken)) return send(response, 401, { error: "coordinator authentication required" });
      if (pathname === "/v1/health" && request.method === "GET") {
        return send(response, 200, { schemaVersion: 1, workerId: options.workerId, capabilities: options.capabilities, active, repositoryHead: await repositoryHead(options.workspace) });
      }
      if (pathname !== "/v1/attempt" || request.method !== "POST") return send(response, 405, { error: "method not allowed" });
      if (active >= options.capabilities.maxConcurrency) return send(response, 409, { error: "worker capacity exhausted" });
      const body = await readJson(request) as unknown as WorkerDispatchRequest;
      validateDispatch(body, options);
      active += 1;
      let prepared: { workspace: string; close(): Promise<void> } | undefined;
      try {
        prepared = await prepareAttemptWorkspace(options.workspace, body.payload.repositorySnapshot);
        if (await repositorySnapshotHash(prepared.workspace) !== body.envelope.repositorySnapshotHash) throw new Error("worker repository snapshot does not match immutable attempt envelope");
        const execution = await options.execute(body, prepared.workspace);
        const files = [] as WorkerResultEnvelope["patch"]["files"];
        for (const path of execution.changedFiles) {
          const absolute = safePath(prepared.workspace, path);
          const content = await readFile(absolute);
          files.push({ path: path.replaceAll("\\", "/"), sha256: sha256(content), size: content.byteLength, contentBase64: content.toString("base64") });
        }
        const unsigned = {
          schemaVersion: 1 as const,
          resultId: randomUUID(),
          attemptId: body.envelope.attemptId,
          workerId: options.workerId,
          fencingToken: body.lease.fencingToken,
          status: execution.status,
          summary: execution.summary,
          patch: { files },
          artifacts: execution.artifacts,
          ...(execution.modelUsage === undefined ? {} : { modelUsage: execution.modelUsage }),
          completedAt: Date.now(),
        };
        const result: WorkerResultEnvelope = { ...unsigned, resultHash: sha256(canonical(unsigned)) };
        return send(response, 200, result);
      } finally {
        await prepared?.close().catch(() => undefined);
        active -= 1;
      }
    } catch (error) {
      send(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  })();
  const server = options.tls ? createSecureServer({ cert: options.tls.cert, key: options.tls.key }, listener) : createServer(listener);
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, host, () => { server.off("error", reject); done(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("worker server has no TCP address");
  const origin = `${options.tls ? "https" : "http"}://${host.includes(":") ? `[${host}]` : host}:${address.port}`;
  return { origin, close: () => new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())) };
}

export async function dispatchToWorker(origin: string, coordinatorToken: string, request: WorkerDispatchRequest): Promise<WorkerResultEnvelope> {
  const response = await fetch(`${origin}/v1/attempt`, {
    method: "POST",
    headers: { authorization: `Bearer ${coordinatorToken}`, "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  const body = await response.json() as WorkerResultEnvelope | { error?: string };
  if (!response.ok) throw new Error("error" in body && body.error ? body.error : `worker request failed with ${response.status}`);
  return body as WorkerResultEnvelope;
}

export async function workerHealth(origin: string, coordinatorToken: string): Promise<{ workerId: string; repositoryHead: string }> {
  const response = await fetch(`${origin}/v1/health`, { headers: { authorization: `Bearer ${coordinatorToken}` } });
  const body = await response.json() as { workerId?: string; repositoryHead?: string; error?: string };
  if (!response.ok || !body.workerId || !body.repositoryHead) throw new Error(body.error ?? `worker health failed with ${response.status}`);
  return { workerId: body.workerId, repositoryHead: body.repositoryHead };
}

export function verifyWorkerResult(result: WorkerResultEnvelope, expected: { attemptId: string; workerId: string; fencingToken: number }): void {
  if (result.schemaVersion !== 1 || result.attemptId !== expected.attemptId || result.workerId !== expected.workerId || result.fencingToken !== expected.fencingToken) {
    throw new Error("worker result identity or fencing mismatch");
  }
  for (const file of result.patch.files) {
    if (isAbsolute(file.path) || file.path.split(/[\\/]/).includes("..")) throw new Error(`worker patch path escapes repository: ${file.path}`);
    const bytes = Buffer.from(file.contentBase64, "base64");
    if (bytes.byteLength !== file.size || sha256(bytes) !== file.sha256) throw new Error(`worker patch file hash mismatch: ${file.path}`);
  }
  const { resultHash, ...unsigned } = result;
  if (sha256(canonical(unsigned)) !== resultHash) throw new Error("worker result envelope hash mismatch");
}

function validateDispatch(request: WorkerDispatchRequest, options: WorkerServerOptions): void {
  if (!request || request.envelope?.schemaVersion !== 1 || request.lease?.attemptId !== request.envelope.attemptId) throw new Error("malformed immutable attempt envelope");
  if (request.lease.workerId !== options.workerId) throw new Error("lease belongs to another worker");
  if (request.lease.expiresAt < Date.now()) throw new Error("worker lease expired before dispatch");
  if (request.envelope.externalAction) throw new Error("worker external action dispatch is forbidden");
  const available = new Set([
    ...options.capabilities.executors.map((value) => `executor:${value}`),
    ...options.capabilities.resources.map((value) => `resource:${value}`),
    ...(options.capabilities.capabilities ?? []).map((value) => `capability:${value}`),
  ]);
  const missing = request.envelope.requiredCapabilities.filter((value) => !available.has(value));
  if (missing.length > 0 || !options.capabilities.executors.includes(request.payload.executor)) throw new Error(`worker capability mismatch: ${missing.join(", ") || request.payload.executor}`);
}

function authorized(request: IncomingMessage, token: string): boolean {
  const supplied = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
  const left = Buffer.from(supplied);
  const right = Buffer.from(token);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 64 * 1024 * 1024) throw new Error("worker request body too large");
    chunks.push(bytes);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("worker request must be a JSON object");
  return value as Record<string, unknown>;
}

async function prepareAttemptWorkspace(baseWorkspace: string, snapshot: WorkerPayload["repositorySnapshot"]): Promise<{ workspace: string; close(): Promise<void> }> {
  if (!snapshot?.commit || !/^[0-9a-f]{40}$/.test(snapshot.commit)) throw new Error("immutable repository snapshot transfer is required");
  const temporary = await mkdtemp(join(tmpdir(), "agr-worker-attempt-"));
  const workspace = join(temporary, "worktree");
  let attached = false;
  try {
    if (snapshot.bundleBase64) {
      const bundle = Buffer.from(snapshot.bundleBase64, "base64");
      if (bundle.byteLength > 40 * 1024 * 1024) throw new Error("repository snapshot bundle exceeds worker limit");
      const bundlePath = join(temporary, "snapshot.bundle");
      await writeFile(bundlePath, bundle, { flag: "wx" });
      await exec("git", ["bundle", "verify", bundlePath], { cwd: baseWorkspace, encoding: "utf8" });
      await exec("git", ["fetch", bundlePath, "HEAD"], { cwd: baseWorkspace, encoding: "utf8" });
    }
    await exec("git", ["cat-file", "-e", `${snapshot.commit}^{commit}`], { cwd: baseWorkspace, encoding: "utf8" });
    await exec("git", ["worktree", "add", "--detach", workspace, snapshot.commit], { cwd: baseWorkspace, encoding: "utf8" });
    attached = true;
    return {
      workspace,
      close: async () => {
        await exec("git", ["worktree", "remove", "--force", workspace], { cwd: baseWorkspace, encoding: "utf8" }).catch(() => undefined);
        await rm(temporary, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (attached) await exec("git", ["worktree", "remove", "--force", workspace], { cwd: baseWorkspace, encoding: "utf8" }).catch(() => undefined);
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

function safePath(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error(`worker path must be relative: ${path}`);
  const absolute = resolve(root, path);
  const rel = relative(resolve(root), absolute);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) throw new Error(`worker path escapes workspace: ${path}`);
  return absolute;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right)))
    : item);
}

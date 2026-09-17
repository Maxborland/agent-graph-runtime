import { randomBytes, randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface NodeProgressReport {
  token: string;
  runId: string;
  nodeId: string;
  phase: string;
  message: string;
  percent?: number;
}

const REPORT_TIMEOUT_MS = 2_000;
const MAX_REPORT_BYTES = 4_096;
const MAX_ACTIVE_SOCKETS = 16;

export interface NodeProgressMilestone {
  at: string;
  phase: string;
  message: string;
  percent?: number;
}

export interface NodeProgressChannel {
  environment: NodeJS.ProcessEnv;
  close(): Promise<void>;
}

export async function createNodeProgressChannel(
  runId: string,
  nodeId: string,
  onReport: (report: NodeProgressMilestone) => void | Promise<void>,
): Promise<NodeProgressChannel> {
  const token = randomBytes(24).toString("hex");
  const unixEndpoint = join(tmpdir(), `agr-progress-${process.pid}-${randomUUID()}.sock`);
  let endpoint = unixEndpoint;
  let lastAcceptedAt = 0;
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    if (sockets.size >= MAX_ACTIVE_SOCKETS) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on("error", () => {
      // A reporter may disconnect while AGR is replying; progress is non-fatal.
    });
    socket.setTimeout(REPORT_TIMEOUT_MS, () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    let raw = "";
    let handled = false;
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      if (handled) return;
      raw += chunk;
      if (Buffer.byteLength(raw, "utf8") > MAX_REPORT_BYTES) {
        handled = true;
        socket.end("rejected");
        return;
      }
      if (!raw.includes("\n")) return;
      handled = true;
      try {
        handleReport(raw.trim());
        socket.end("ok");
      } catch {
        socket.end("rejected");
      }
    });
  });

  const handleReport = (raw: string): void => {
    const value = JSON.parse(raw) as Partial<NodeProgressReport>;
    if (
      value.token !== token ||
      value.runId !== runId ||
      value.nodeId !== nodeId ||
      typeof value.phase !== "string" ||
      !/^[a-z][a-z0-9_-]{0,31}$/.test(value.phase) ||
      typeof value.message !== "string" ||
      value.message.length === 0 ||
      value.message.length > 240 ||
      /[\r\n\u0000-\u001f\u007f]/.test(value.message) ||
      (value.percent !== undefined && (!Number.isInteger(value.percent) || value.percent < 0 || value.percent > 100))
    ) {
      throw new Error("invalid node progress report");
    }
    const now = Date.now();
    if (now - lastAcceptedAt < 100) throw new Error("node progress report rate exceeded");
    lastAcceptedAt = now;
    void Promise.resolve(onReport({
        at: new Date(now).toISOString(),
        phase: value.phase,
        message: value.message,
        ...(value.percent === undefined ? {} : { percent: value.percent }),
      })).catch(() => {
        // Observability persistence/rendering cannot change executor behavior.
      });
  };

  await new Promise<void>((resolveListening, rejectListening) => {
    server.once("error", rejectListening);
    if (process.platform === "win32") {
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          rejectListening(new Error("node progress channel did not expose a loopback address"));
          return;
        }
        endpoint = `tcp://127.0.0.1:${address.port}`;
        resolveListening();
      });
      return;
    }
    server.listen(unixEndpoint, resolveListening);
  });
  return {
    environment: {
      AGR_PROGRESS_ENDPOINT: endpoint,
      AGR_PROGRESS_TOKEN: token,
      AGR_RUN_ID: runId,
      AGR_NODE_ID: nodeId,
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      if (process.platform !== "win32") await rm(unixEndpoint, { force: true });
    },
  };
}

export async function sendNodeProgress(
  endpoint: string,
  report: NodeProgressReport,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connectToProgressEndpoint(endpoint);
    let response = "";
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error(`node progress channel did not respond within ${REPORT_TIMEOUT_MS}ms`)),
      REPORT_TIMEOUT_MS,
    );
    socket.setEncoding("utf8");
    socket.once("error", (error) => finish(error));
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.length > 32) finish(new Error("node progress channel returned an invalid response"));
    });
    socket.once("end", () => {
      if (response.trim() === "ok") finish();
      else finish(new Error("node progress channel rejected the report"));
    });
    socket.once("connect", () => socket.write(`${JSON.stringify(report)}\n`));
  });
}

function connectToProgressEndpoint(endpoint: string): import("node:net").Socket {
  if (!endpoint.startsWith("tcp://")) {
    if (process.platform === "win32") {
      throw new Error("node progress channel endpoint is not loopback TCP");
    }
    return createConnection(endpoint);
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("node progress channel endpoint is invalid");
  }
  const port = Number(url.port);
  if (
    url.protocol !== "tcp:" ||
    url.hostname !== "127.0.0.1" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    url.pathname !== ""
  ) {
    throw new Error("node progress channel endpoint is not loopback TCP");
  }
  return createConnection({ host: url.hostname, port });
}

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
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\agr-progress-${process.pid}-${randomUUID()}`
    : join(tmpdir(), `agr-progress-${process.pid}-${randomUUID()}.sock`);
  let lastAcceptedAt = 0;
  const sockets = new Set<import("node:net").Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
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
    server.listen(endpoint, resolveListening);
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
      if (process.platform !== "win32") await rm(endpoint, { force: true });
    },
  };
}

export async function sendNodeProgress(
  endpoint: string,
  report: NodeProgressReport,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = createConnection(endpoint);
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

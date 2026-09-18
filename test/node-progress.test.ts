import assert from "node:assert/strict";
import { createConnection } from "node:net";
import test from "node:test";

import { createNodeProgressChannel, sendNodeProgress } from "../src/node-progress.js";

function connectToEndpoint(endpoint: string) {
  if (!endpoint.startsWith("tcp://")) return createConnection(endpoint);
  const url = new URL(endpoint);
  return createConnection({ host: url.hostname, port: Number(url.port) });
}

test("Windows node progress uses loopback TCP instead of a named pipe", async () => {
  const channel = await createNodeProgressChannel("run", "node", () => undefined);
  try {
    if (process.platform === "win32") {
      assert.match(channel.environment.AGR_PROGRESS_ENDPOINT ?? "", /^tcp:\/\/127\.0\.0\.1:\d+$/);
    }
  } finally {
    await channel.close();
  }
});

test("Windows node progress rejects injected non-loopback endpoints", async () => {
  if (process.platform !== "win32") return;
  await assert.rejects(
    sendNodeProgress("\\\\.\\pipe\\foreign-progress", {
      token: "token",
      runId: "run",
      nodeId: "node",
      phase: "verify",
      message: "rejected",
    }),
    /loopback TCP/,
  );
});

test("node progress channel rejects a spoofed token", async () => {
  const reports: unknown[] = [];
  const channel = await createNodeProgressChannel("run", "node", (report) => {
    reports.push(report);
  });
  try {
    await assert.rejects(
      sendNodeProgress(channel.environment.AGR_PROGRESS_ENDPOINT!, {
        token: "wrong-token",
        runId: "run",
        nodeId: "node",
        phase: "verify",
        message: "spoofed",
      }),
      /rejected/,
    );
    assert.deepEqual(reports, []);
  } finally {
    await channel.close();
  }
});

test("node progress channel rejects wrong run/node identities and oversized messages", async () => {
  const reports: unknown[] = [];
  const channel = await createNodeProgressChannel("run", "node", (report) => {
    reports.push(report);
  });
  const endpoint = channel.environment.AGR_PROGRESS_ENDPOINT!;
  const base = {
    token: channel.environment.AGR_PROGRESS_TOKEN!,
    runId: "run",
    nodeId: "node",
    phase: "verify",
    message: "rejected",
  };
  try {
    await assert.rejects(sendNodeProgress(endpoint, { ...base, runId: "other-run" }), /rejected/);
    await assert.rejects(sendNodeProgress(endpoint, { ...base, nodeId: "other-node" }), /rejected/);

    const socket = connectToEndpoint(endpoint);
    const response = new Promise<string>((resolveResponse, rejectResponse) => {
      let responseText = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => { responseText += chunk; });
      socket.once("error", rejectResponse);
      socket.once("end", () => resolveResponse(responseText));
    });
    await new Promise<void>((resolveConnected, rejectConnected) => {
      socket.once("connect", resolveConnected);
      socket.once("error", rejectConnected);
    });
    socket.end(`${"x".repeat(5_000)}\n`);
    assert.equal((await response).trim(), "rejected");
    assert.deepEqual(reports, []);
  } finally {
    await channel.close();
  }
});

test("closing node progress cannot hang on a silent client", async () => {
  const channel = await createNodeProgressChannel("run", "node", () => undefined);
  const socket = connectToEndpoint(channel.environment.AGR_PROGRESS_ENDPOINT!);
  await new Promise<void>((resolveConnected, rejectConnected) => {
    socket.once("connect", resolveConnected);
    socket.once("error", rejectConnected);
  });
  const started = Date.now();
  await channel.close();
  assert.ok(Date.now() - started < 500, "progress close waited on a silent client");
});

test("node progress tolerates a reporter that resets the TCP connection", async () => {
  if (process.platform !== "win32") return;
  const channel = await createNodeProgressChannel("run", "node", () => undefined);
  const endpoint = channel.environment.AGR_PROGRESS_ENDPOINT!;
  const socket = connectToEndpoint(endpoint);
  socket.once("error", () => undefined);
  try {
    await new Promise<void>((resolveConnected, rejectConnected) => {
      socket.once("connect", resolveConnected);
      socket.once("error", rejectConnected);
    });
    socket.write(`${JSON.stringify({
      token: channel.environment.AGR_PROGRESS_TOKEN,
      runId: "run",
      nodeId: "node",
      phase: "verify",
      message: "reset",
    })}\n`);
    socket.destroy();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  } finally {
    await channel.close();
  }
});

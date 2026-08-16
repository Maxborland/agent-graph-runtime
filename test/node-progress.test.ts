import assert from "node:assert/strict";
import { createConnection } from "node:net";
import test from "node:test";

import { createNodeProgressChannel, sendNodeProgress } from "../src/node-progress.js";

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

test("closing node progress cannot hang on a silent client", async () => {
  const channel = await createNodeProgressChannel("run", "node", () => undefined);
  const socket = createConnection(channel.environment.AGR_PROGRESS_ENDPOINT!);
  await new Promise<void>((resolveConnected, rejectConnected) => {
    socket.once("connect", resolveConnected);
    socket.once("error", rejectConnected);
  });
  const started = Date.now();
  await channel.close();
  assert.ok(Date.now() - started < 500, "progress close waited on a silent client");
});

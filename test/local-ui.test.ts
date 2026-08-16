import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";

import { startLocalControlServer } from "../src/local-ui.js";

test("local UI rejects unauthenticated, cross-origin, rebinding, CSRF, and replay requests", async (t) => {
  const calls: unknown[] = [];
  const ui = await startLocalControlServer({
    host: "127.0.0.1",
    readModel: async () => ({ runId: "safe", status: "running", nodes: [] }),
    command: async (request: unknown) => { calls.push(request); return { ok: true }; },
  });
  t.after(() => ui.close());
  const shell = await (await fetch(ui.origin)).text();
  assert.match(shell, /Preview command/);
  assert.doesNotMatch(shell, /provider|prompt|tool arguments/i);
  assert.equal((await fetch(`${ui.origin}/api/status`)).status, 401);
  assert.equal(await rawStatus(ui.origin, "/api/status", { "x-agr-session": ui.session, host: "attacker.test" }), 403);
  assert.equal((await fetch(`${ui.origin}/api/status`, { headers: { "x-agr-session": ui.session, origin: "https://attacker.test" } })).status, 403);
  const options = await fetch(`${ui.origin}/api/status`, { method: "OPTIONS", headers: { origin: "https://attacker.test" } });
  assert.equal(options.headers.get("access-control-allow-origin"), null);

  const preview = await fetch(`${ui.origin}/api/command/preview`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agr-session": ui.session, "x-agr-csrf": ui.csrf, origin: ui.origin },
    body: JSON.stringify({ command: "retry", arguments: { nodeId: "build" } }),
  });
  assert.equal(preview.status, 200);
  const { previewId } = await preview.json() as { previewId: string };
  const execute = () => fetch(`${ui.origin}/api/command/execute`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agr-session": ui.session, "x-agr-csrf": ui.csrf, origin: ui.origin },
    body: JSON.stringify({ previewId }),
  });
  assert.equal((await execute()).status, 200);
  assert.equal((await execute()).status, 409);
  assert.equal(calls.length, 1);
});

function rawStatus(origin: string, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(new URL(path, origin), { headers }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode ?? 0));
    });
    req.once("error", reject);
    req.end();
  });
}

test("plaintext LAN UI startup is rejected", async () => {
  await assert.rejects(() => startLocalControlServer({
    host: "0.0.0.0",
    readModel: async () => ({}),
    command: async () => ({}),
  }), /TLS/);
});

test("wildcard LAN binding requires an explicit public host", async () => {
  await assert.rejects(() => startLocalControlServer({
    host: "0.0.0.0",
    tls: { cert: "invalid", key: "invalid" },
    readModel: async () => ({}),
    command: async () => ({}),
  }), /publicHost/);
});
